'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  session
} = require('electron');

const START_URL = 'https://pocketoption.com/ru/cabinet/demo-quick-high-low/';
const PARTITION = 'persist:pocket-tracker-desktop';
const EXTENSION_DIR = path.join(__dirname, 'extension');

let dashboardWindow = null;
let siteWindow = null;
let extensionInfo = null;
let extensionError = null;
let appQuitting = false;
let statusTimer = null;
let statusBusy = false;
let backgroundTestRunning = false;
let logFile = null;

// Set before app readiness so Chromium receives the background scheduling switch.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.show();
      dashboardWindow.focus();
    }
    if (siteWindow && !siteWindow.isDestroyed()) {
      siteWindow.show();
      siteWindow.focus();
    }
  });

  app.whenReady().then(boot).catch(error => {
    console.error('[Pocket Tracker Desktop] startup failed:', error);
    app.quit();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeLog(message) {
  const line = new Date().toISOString() + '  ' + String(message);
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch (_) {}
  }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('app:log', line);
  }
}

async function boot() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'desktop.log');

  createDashboardWindow();

  const poSession = session.fromPartition(PARTITION);
  try {
    extensionInfo = await poSession.extensions.loadExtension(EXTENSION_DIR);
    writeLog('Расширение загружено: ' + extensionInfo.name + ' (' + extensionInfo.id + ')');
  } catch (error) {
    extensionError = String(error && error.stack ? error.stack : error);
    writeLog('ОШИБКА загрузки расширения: ' + extensionError);
  }

  createSiteWindow(poSession);
  statusTimer = setInterval(() => {
    void publishStatus();
  }, 2500);

  app.on('activate', () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.show();
  });
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    title: 'Pocket Tracker Desktop',
    width: 780,
    height: 760,
    minWidth: 680,
    minHeight: 640,
    backgroundColor: '#0b1018',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    if (!appQuitting) app.quit();
  });
}

function createSiteWindow(poSession) {
  siteWindow = new BrowserWindow({
    title: 'Pocket Option — торговая сессия',
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    show: true,
    backgroundColor: '#0b1018',
    autoHideMenuBar: true,
    webPreferences: {
      session: poSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  siteWindow.webContents.setBackgroundThrottling(false);

  siteWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1050,
          height: 800,
          autoHideMenuBar: true,
          webPreferences: {
            session: poSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
          }
        }
      };
    }
    return { action: 'deny' };
  });

  siteWindow.webContents.on('did-finish-load', () => {
    writeLog('Pocket Option: страница загружена — ' + siteWindow.webContents.getURL());
    void publishStatus();
  });

  siteWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) {
      writeLog('Ошибка загрузки сайта (' + code + '): ' + description + ' — ' + url);
    }
    void publishStatus();
  });

  siteWindow.webContents.on('render-process-gone', (_event, details) => {
    writeLog('Процесс страницы завершился: ' + JSON.stringify(details));
    void publishStatus();
  });

  siteWindow.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'string' ? details : details && details.message;
    if (message && /PocketOption Signal|Pocket Tracker Desktop/i.test(message)) {
      writeLog('[PAGE] ' + message);
    }
  });

  siteWindow.on('close', event => {
    if (!appQuitting) {
      event.preventDefault();
      siteWindow.hide();
      writeLog('Окно Pocket Option скрыто; сессия браузера остаётся открытой.');
      void publishStatus();
    }
  });

  siteWindow.on('hide', () => void publishStatus());
  siteWindow.on('show', () => void publishStatus());
  siteWindow.on('closed', () => {
    siteWindow = null;
    void publishStatus();
  });

  siteWindow.loadURL(START_URL).catch(error => {
    writeLog('Не удалось открыть Pocket Option: ' + String(error));
  });
}

async function readPageProbe() {
  if (!siteWindow || siteWindow.isDestroyed()) return null;

  const script = `(() => {
    const probe = window.__PT_DESKTOP_BG_PROBE__;
    const sockets = Array.isArray(window.__po_wsConnections)
      ? window.__po_wsConnections
      : [];
    const active = window.__po_ws || null;
    const openSocket = !!(active && active.readyState === 1) ||
      sockets.some(item => item && item.ws && item.ws.readyState === 1);
    const badge = document.getElementById('pt4-account-mode-badge');

    return {
      extensionInjected: !!window.__PT_DESKTOP_EXTENSION_INJECTED__,
      engineLoaded: !!window.__poCore,
      probe: probe ? {
        ticks: Number(probe.ticks) || 0,
        lastTickAt: Number(probe.lastTickAt) || 0,
        visibilityState: probe.visibilityState || document.visibilityState
      } : null,
      webSocketOpen: openSocket,
      webSocketCount: sockets.length,
      accountMode: badge ? (badge.textContent || '').trim() : 'Ожидание определения',
      botPanelPresent: !!document.getElementById('pos-panel'),
      visibilityState: document.visibilityState,
      title: document.title,
      url: location.href
    };
  })()`;

  try {
    return await siteWindow.webContents.executeJavaScript(script, true);
  } catch (error) {
    return { probeError: String(error) };
  }
}

async function getStatus() {
  const page = await readPageProbe();
  const siteAlive = !!(siteWindow && !siteWindow.isDestroyed());

  return {
    appVersion: app.getVersion(),
    extension: {
      loaded: !!extensionInfo,
      id: extensionInfo ? extensionInfo.id : null,
      name: extensionInfo ? extensionInfo.name : null,
      error: extensionError
    },
    site: {
      alive: siteAlive,
      loading: siteAlive ? siteWindow.webContents.isLoading() : false,
      visible: siteAlive ? siteWindow.isVisible() : false,
      minimized: siteAlive ? siteWindow.isMinimized() : false,
      backgroundThrottling: siteAlive ? siteWindow.webContents.getBackgroundThrottling() : null,
      page: page
    },
    backgroundTestRunning: backgroundTestRunning
  };
}

async function publishStatus() {
  if (statusBusy || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  statusBusy = true;
  try {
    const status = await getStatus();
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('app:status', status);
    }
  } finally {
    statusBusy = false;
  }
}

ipcMain.handle('app:get-status', () => getStatus());

ipcMain.handle('app:show-site', () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  siteWindow.show();
  siteWindow.focus();
  return { ok: true };
});

ipcMain.handle('app:hide-site', () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  siteWindow.hide();
  void publishStatus();
  return { ok: true };
});

ipcMain.handle('app:reload-site', async () => {
  if (!siteWindow || siteWindow.isDestroyed()) return { ok: false };
  await siteWindow.webContents.reload();
  return { ok: true };
});

ipcMain.handle('app:background-test', async () => {
  if (backgroundTestRunning) {
    return { passed: false, reason: 'Тест уже выполняется.' };
  }
  if (!siteWindow || siteWindow.isDestroyed()) {
    return { passed: false, reason: 'Окно Pocket Option не запущено.' };
  }

  const before = await readPageProbe();
  if (!before || !before.probe) {
    return {
      passed: false,
      reason: 'Контрольный скрипт ещё не обнаружен. Дождитесь загрузки сайта и расширения.'
    };
  }

  backgroundTestRunning = true;
  siteWindow.hide();
  const startedAt = Date.now();
  const initialTicks = before.probe.ticks;
  writeLog('Начат тест фонового выполнения на 30 секунд. Окно сайта скрыто.');
  void publishStatus();

  try {
    for (let remaining = 30; remaining > 0; remaining -= 1) {
      await sleep(1000);
      if (!siteWindow || siteWindow.isDestroyed()) {
        return { passed: false, reason: 'Окно сайта было закрыто во время теста.' };
      }
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('app:test-progress', { remaining: remaining - 1 });
      }
    }

    const after = await readPageProbe();
    const elapsedMs = Date.now() - startedAt;
    if (!after || !after.probe) {
      return { passed: false, reason: 'Контрольный скрипт перестал отвечать.', elapsedMs };
    }

    const tickDelta = after.probe.ticks - initialTicks;
    const tickAgeMs = Date.now() - after.probe.lastTickAt;
    const hidden = siteWindow && !siteWindow.isVisible();
    const passed = hidden && tickDelta >= 23 && tickAgeMs <= 3500 &&
      after.visibilityState === 'visible';

    const result = {
      passed,
      elapsedMs,
      tickDelta,
      tickAgeMs,
      pageHidden: hidden,
      pageVisibilityState: after.visibilityState,
      webSocketOpen: after.webSocketOpen,
      engineLoaded: after.engineLoaded,
      extensionInjected: after.extensionInjected,
      accountMode: after.accountMode,
      reason: passed
        ? 'JavaScript таймер продолжал работать, пока окно Pocket Option было скрыто.'
        : 'Фоновый тест не прошёл пороги проверки. Посмотрите показатели и журнал.'
    };

    writeLog((passed ? 'ТЕСТ ПРОЙДЕН: ' : 'ТЕСТ НЕ ПРОЙДЕН: ') +
      'тикает ' + tickDelta + ' раз; задержка последнего тика ' + tickAgeMs + ' мс; WebSocket ' +
      (after.webSocketOpen ? 'подключён' : 'не подключён') + '.');

    return result;
  } finally {
    backgroundTestRunning = false;
    void publishStatus();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  if (statusTimer) clearInterval(statusTimer);
});

app.on('window-all-closed', () => {
  app.quit();
});
