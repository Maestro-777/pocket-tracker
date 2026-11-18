'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell
} = require('electron');

const ACCOUNT_URLS = {
  DEMO: 'https://pocketoption.com/ru/cabinet/demo-quick-high-low/',
  REAL: 'https://pocketoption.com/ru/cabinet/quick-high-low/RUB/'
};
const DEFAULT_ACCOUNT = 'DEMO';
const START_URL = ACCOUNT_URLS[DEFAULT_ACCOUNT];
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  process.versions.chrome + ' Safari/537.36';
const PARTITION = 'persist:pocket-tracker-desktop';
const EXTENSION_DIR = path.join(__dirname, 'extension');
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_INTERVAL_MS = 2500;
const TELEMETRY_FLUSH_INTERVAL_MS = 5000;
const RECOVERY_POLL_INTERVAL_MS = 10000;
const RECOVERY_GRACE_MS = 90000;
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 3;

let dashboardWindow = null;
let siteWindow = null;
let extensionInfo = null;
let extensionError = null;
let appQuitting = false;
let statusTimer = null;
let statusBusy = false;
let backgroundTestRunning = false;
let selectedAccount = DEFAULT_ACCOUNT;
let lastLoadError = null;
let logFile = null;
let statsDirectory = null;
let poSession = null;
let healthTimer = null;
let telemetryTimer = null;
let recoveryTimer = null;
let lastPageSnapshot = null;
let lastHealthSummary = null;
let lastHealthAt = 0;
let previousHealthProbe = null;
let healthCheckBusy = false;
let shutdownStarted = false;
let watchdogRestartRequested = false;
let socketMissingSince = 0;
let transportHealthySince = 0;
let lastRecoveryAt = 0;
let lastRecoveryWarningAt = 0;
let recoveryAttempts = 0;
const persistedTelemetryIds = new Set();
let telemetryCursor = { sessionId: null, signals: 0, trades: 0 };

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

function appendJsonLine(kind, record) {
  if (!statsDirectory) return;
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(statsDirectory, kind + '-' + day + '.jsonl');
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    writeLog('Не удалось сохранить статистику ' + kind + ': ' + String(error));
  }
}

function persistTelemetryEvents(telemetry) {
  if (!telemetry || !telemetry.sessionId) return;
  const events = []
    .concat(Array.isArray(telemetry.signals) ? telemetry.signals : [])
    .concat(Array.isArray(telemetry.trades) ? telemetry.trades : []);

  for (const event of events) {
    if (!event || !event.id || persistedTelemetryIds.has(event.id)) continue;
    persistedTelemetryIds.add(event.id);
    const kind = String(event.type || '').includes('TRADE') ? 'trades' : 'signals';
    appendJsonLine(kind, event);
  }

  if (persistedTelemetryIds.size > 12000) {
    const keep = Array.from(persistedTelemetryIds).slice(-6000);
    persistedTelemetryIds.clear();
    for (const id of keep) persistedTelemetryIds.add(id);
  }
}

async function flushPageTelemetry() {
  if (!siteWindow || siteWindow.isDestroyed()) return;
  try {
    const cursor = JSON.stringify(telemetryCursor);
    const telemetry = await siteWindow.webContents.executeJavaScript(`(() => {
      const probe = window.__PT_DESKTOP_BG_PROBE__;
      const value = probe && probe.telemetry;
      const cursor = ${cursor};
      if (!value) return null;
      const sameSession = cursor.sessionId === value.sessionId;
      const signalAfter = sameSession ? cursor.signals : 0;
      const tradeAfter = sameSession ? cursor.trades : 0;
      return {
        sessionId: value.sessionId,
        signals: (value.signals || []).filter(item => (item.sequence || 0) > signalAfter),
        trades: (value.trades || []).filter(item => (item.sequence || 0) > tradeAfter)
      };
    })()`, true);
    if (!telemetry) return;
    if (telemetryCursor.sessionId !== telemetry.sessionId) {
      telemetryCursor = { sessionId: telemetry.sessionId, signals: 0, trades: 0 };
    }
    for (const event of telemetry.signals || []) {
      telemetryCursor.signals = Math.max(telemetryCursor.signals, Number(event.sequence) || 0);
    }
    for (const event of telemetry.trades || []) {
      telemetryCursor.trades = Math.max(telemetryCursor.trades, Number(event.sequence) || 0);
    }
    persistTelemetryEvents(telemetry);
  } catch (_) {}
}

async function readPageScanSnapshot() {
  if (!siteWindow || siteWindow.isDestroyed()) return null;
  try {
    return await siteWindow.webContents.executeJavaScript(`(() => {
      const probe = window.__PT_DESKTOP_BG_PROBE__;
      const value = probe && probe.telemetry;
      if (!value) return null;
      return {
        sessionId: value.sessionId,
        scanCount: value.scanCount || 0,
        lastScanAt: value.lastScanAt || 0,
        lastScan: value.lastScan || null,
        perAssetLastScan: value.perAssetLastScan || {}
      };
    })()`, true);
  } catch (_) {
    return null;
  }
}

function getTransportHealth(page) {
  const probe = page && page.probe ? page.probe : {};
  const core = probe.core || {};
  const socketOpen = !!(page && page.webSocketOpen) ||
    !!probe.webSocketOpen ||
    Number(probe.webSocketOpenCount || 0) > 0;
  const quoteAgeMs = core.quoteAgeMs == null ? null : Number(core.quoteAgeMs);
  const quoteFresh = quoteAgeMs != null && Number.isFinite(quoteAgeMs) && quoteAgeMs <= 30000;
  const engineNeedsLiveQuotes = !!core.running && !!core.asset;
  return {
    ok: engineNeedsLiveQuotes ? (socketOpen && quoteFresh) : (socketOpen || quoteFresh),
    socketOpen,
    quoteFresh,
    quoteAgeMs,
    engineNeedsLiveQuotes
  };
}

function buildHealthSummary(status, reason, elapsedMs, tickDelta, scanDelta) {
  const site = status.site || {};
  const page = site.page || {};
  const probe = page.probe || {};
  const core = probe.core || {};
  const telemetry = probe.telemetry || {};
  const now = Date.now();
  const timerAgeMs = probe.lastTickAt ? now - probe.lastTickAt : null;
  const transport = getTransportHealth(page);
  const quoteAgeMs = transport.quoteAgeMs;
  const transportOk = transport.ok;
  const timerOk = !!probe.lastTickAt && timerAgeMs <= 3500 &&
    (tickDelta == null || elapsedMs < 10000 || tickDelta >= Math.floor(elapsedMs / 1000 * 0.70));
  const scanExpected = core.running && elapsedMs >= 10000
    ? Math.max(1, Math.floor(elapsedMs / 1500 * 0.30))
    : 0;
  const scanOk = !core.running || scanDelta == null || scanDelta >= scanExpected;

  const critical = [];
  const warnings = [];
  if (!status.extension || !status.extension.loaded) critical.push('Расширение не загружено');
  if (!probe.lastTickAt || !timerOk) critical.push('Контрольный фоновый таймер не отвечает');
  if (probe.online === false) warnings.push('Windows сообщает об отсутствии сети');
  if (!transportOk) warnings.push('WebSocket не подключён или котировки устарели');
  if (!core.loaded) critical.push('QuotexCore не обнаружен');
  if (core.running && !scanOk) warnings.push('Сканер работает реже ожидаемого');
  if (core.running && quoteAgeMs != null && quoteAgeMs > 30000) warnings.push('Последняя котировка старше 30 секунд');
  if (!core.running) warnings.push('Сканер не запущен в интерфейсе; сигналы пока не анализируются');

  const statusText = critical.length
    ? 'Ошибка'
    : warnings.length
      ? (core.running || !warnings.every(x => x.startsWith('Сканер не запущен')) ? 'Есть замечания' : 'Ожидание сканера')
      : 'В норме';
  const level = critical.length ? 'bad' : warnings.length ? 'warning' : 'good';

  return {
    at: new Date(now).toISOString(),
    reason,
    status: statusText,
    level,
    elapsedMs,
    timerOk,
    timerAgeMs,
    tickDelta,
    online: probe.online !== false,
    webSocketOpen: transport.socketOpen,
    quoteFresh: transport.quoteFresh,
    webSocketOpenCount: probe.webSocketOpenCount || page.webSocketCount || 0,
    engineLoaded: !!core.loaded,
    engineRunning: !!core.running,
    engineAsset: core.asset || null,
    autoTrade: !!core.autoTrade,
    quoteAgeMs,
    trackedAssetCount: core.trackedAssetCount || 0,
    freshAssets: core.assetsWithFreshQuotes || [],
    scanCount: telemetry.scanCount || 0,
    scanDelta,
    scanOk,
    signalCount: telemetry.signalCount || 0,
    tradeCount: telemetry.tradeCount || 0,
    latestScanAt: telemetry.lastScanAt || 0,
    latestScan: telemetry.lastScan || null,
    analysis: core.analysis || null,
    config: core.config || null,
    warnings,
    critical
  };
}

async function runAutoHealthCheck(reason) {
  if (healthCheckBusy || appQuitting) return;
  healthCheckBusy = true;
  try {
    const status = await getStatus();
    const page = status.site && status.site.page ? status.site.page : {};
    const probe = page.probe || {};
    const telemetry = probe.telemetry || {};
    const now = Date.now();
    const elapsedMs = lastHealthAt ? now - lastHealthAt : 0;
    const tickDelta = previousHealthProbe && probe.ticks != null
      ? Math.max(0, probe.ticks - previousHealthProbe.ticks)
      : null;
    const scanDelta = previousHealthProbe && telemetry.scanCount != null
      ? Math.max(0, telemetry.scanCount - previousHealthProbe.scanCount)
      : null;

    const summary = buildHealthSummary(status, reason, elapsedMs, tickDelta, scanDelta);
    lastHealthSummary = summary;
    lastHealthAt = now;
    previousHealthProbe = {
      ticks: probe.ticks || 0,
      scanCount: telemetry.scanCount || 0
    };

    appendJsonLine('health', {
      schemaVersion: 1,
      ...summary,
      extension: status.extension || {},
      site: {
        url: page.url || null,
        loading: !!(status.site && status.site.loading),
        visible: !!(status.site && status.site.visible),
        documentVisibility: page.visibilityState || null
      }
    });
    appendJsonLine('scans', {
      schemaVersion: 1,
      at: summary.at,
      windowMs: elapsedMs,
      scanCount: summary.scanCount,
      scanDelta,
      engineRunning: summary.engineRunning,
      engineAsset: summary.engineAsset,
      latestScan: summary.latestScan,
      analysis: summary.analysis,
      config: summary.config,
      perAssetLastScan: (await readPageScanSnapshot())?.perAssetLastScan || {}
    });

    writeLog('АВТОПРОВЕРКА ' + summary.status +
      ' | таймер: ' + (tickDelta == null ? 'база' : '+' + tickDelta) +
      ' | сканирование: ' + (scanDelta == null ? 'база' : '+' + scanDelta) +
      ' | WebSocket: ' + (summary.webSocketOpen ? 'есть' : 'нет') +
      ' | QuotexCore: ' + (summary.engineRunning ? 'работает' : 'не запущено'));

    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('app:health', summary);
    }
  } catch (error) {
    writeLog('Ошибка автоматической проверки: ' + String(error));
  } finally {
    healthCheckBusy = false;
    void publishStatus();
  }
}

function monitorConnectionRecovery() {
  if (appQuitting || !siteWindow || siteWindow.isDestroyed() || siteWindow.webContents.isLoading()) return;
  const page = lastPageSnapshot;
  const probe = page && page.probe;
  if (!probe) return;

  const now = Date.now();
  const core = probe.core || {};
  if (probe.online === false) {
    if (!socketMissingSince) {
      socketMissingSince = now;
      writeLog('Сеть недоступна; автоматическое восстановление ждёт возвращения подключения.');
    }
    return;
  }

  const transportOk = getTransportHealth(page).ok;
  if (transportOk) {
    if (!transportHealthySince) transportHealthySince = now;
    if (now - transportHealthySince >= 120000) {
      socketMissingSince = 0;
      recoveryAttempts = 0;
      lastRecoveryAt = 0;
    }
    return;
  }

  transportHealthySince = 0;
  if (!socketMissingSince) {
    socketMissingSince = now;
    writeLog('WebSocket/котировки не обнаружены; начато ожидание восстановления.');
    return;
  }
  if (now - socketMissingSince < RECOVERY_GRACE_MS) return;

  if (core.running || core.autoTrade || core.tradeBusy) {
    if (now - lastRecoveryWarningAt > 60000) {
      lastRecoveryWarningAt = now;
      writeLog('ВНИМАНИЕ: соединение не восстановилось, но перезагрузка страницы пропущена — торговое ядро/автоторговля активны.');
    }
    return;
  }
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return;
  if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;

  recoveryAttempts += 1;
  lastRecoveryAt = now;
  writeLog('Автовосстановление соединения: перезагрузка страницы, попытка ' +
    recoveryAttempts + '/' + MAX_RECOVERY_ATTEMPTS + '. Авторизация хранится в постоянном профиле.');
  siteWindow.webContents.reload().catch(error => {
    writeLog('Ошибка автоматической перезагрузки: ' + String(error));
  });
}

async function gracefulShutdown() {
  if (statusTimer) clearInterval(statusTimer);
  if (healthTimer) clearInterval(healthTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (recoveryTimer) clearInterval(recoveryTimer);

  writeLog('Начато корректное завершение. Останавливаю анализатор и сохраняю профиль Chromium.');
  try {
    if (siteWindow && !siteWindow.isDestroyed()) {
      await Promise.race([
        siteWindow.webContents.executeJavaScript(`(() => {
          const core = window.__poCore;
          if (core && typeof core.stop === 'function') {
            core.stop();
            return 'QuotexCore stopped';
          }
          return 'QuotexCore not running';
        })()`, true),
        sleep(4000)
      ]);
    }
  } catch (error) {
    writeLog('Не удалось отправить команду остановки ядру: ' + String(error));
  }

  try {
    if (poSession && typeof poSession.flushStorageData === 'function') {
      poSession.flushStorageData();
    }
    writeLog('Профиль Chromium сохранён: ' +
      (poSession && typeof poSession.getStoragePath === 'function'
        ? poSession.getStoragePath()
        : PARTITION));
  } catch (error) {
    writeLog('Предупреждение при сохранении профиля: ' + String(error));
  }

  try {
    await Promise.race([flushPageTelemetry(), sleep(3000)]);
  } catch (_) {}
  await sleep(200);
  app.exit(watchdogRestartRequested ? 75 : 0);
}

async function boot() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'desktop.log');
  statsDirectory = path.join(app.getPath('userData'), 'stats');
  fs.mkdirSync(statsDirectory, { recursive: true });

  createDashboardWindow();

  poSession = session.fromPartition(PARTITION);
  // Use Windows system proxy settings explicitly, matching the OS-level route
  // used by desktop browsers where possible. Never bypass TLS validation.
  try {
    await poSession.setProxy({ mode: 'system' });
    const proxyRoute = await poSession.resolveProxy(START_URL);
    writeLog('Системный прокси для Pocket Option: ' + proxyRoute);
  } catch (error) {
    writeLog('Не удалось определить системный прокси: ' + String(error));
  }

  // Use a regular Chromium UA rather than exposing Electron in the HTTP User-Agent.
  poSession.setUserAgent(CHROME_USER_AGENT, 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
  writeLog('Chromium: ' + process.versions.chrome + '; User-Agent Electron скрыт.');
  writeLog('Постоянный профиль: ' +
    (typeof poSession.getStoragePath === 'function' ? poSession.getStoragePath() : PARTITION));
  writeLog('Каталог статистики: ' + statsDirectory);
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
  }, STATUS_INTERVAL_MS);
  telemetryTimer = setInterval(() => {
    void flushPageTelemetry();
  }, TELEMETRY_FLUSH_INTERVAL_MS);
  healthTimer = setInterval(() => {
    void runAutoHealthCheck('5-minute');
  }, HEALTH_INTERVAL_MS);
  recoveryTimer = setInterval(monitorConnectionRecovery, RECOVERY_POLL_INTERVAL_MS);
  setTimeout(() => {
    void runAutoHealthCheck('startup');
  }, 20000);

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

  siteWindow.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      lastLoadError = null;
      writeLog('Начата навигация Pocket Option: ' + url);
      void publishStatus();
    }
  });

  siteWindow.webContents.on('did-redirect-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) writeLog('Перенаправление Pocket Option: ' + url);
  });

  siteWindow.webContents.on('dom-ready', () => {
    writeLog('Pocket Option: DOM готов — ' + siteWindow.webContents.getURL());
    void publishStatus();
  });

  siteWindow.webContents.on('did-navigate', (_event, url) => {
    lastLoadError = null;
    writeLog('Pocket Option: переход завершён — ' + url);
    void publishStatus();
  });

  siteWindow.webContents.on('did-finish-load', () => {
    lastLoadError = null;
    writeLog('Pocket Option: страница загружена — ' + siteWindow.webContents.getURL());
    void publishStatus();
  });

  siteWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      lastLoadError = {
        code,
        description,
        url,
        isMainFrame: true,
        at: new Date().toISOString()
      };
    }
    writeLog('Ошибка загрузки сайта (' + code + ', ' +
      (isMainFrame ? 'главный фрейм' : 'вложенный фрейм') + '): ' + description + ' — ' + url);
    void publishStatus();
  });

  siteWindow.webContents.on('render-process-gone', (_event, details) => {
    writeLog('Процесс страницы завершился: ' + JSON.stringify(details));
    void publishStatus();
  });

  siteWindow.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'string' ? details : details && details.message;
    const level = details && typeof details.level === 'number' ? details.level : 0;
    if (message && (level >= 2 || /PocketOption Signal|Pocket Tracker Desktop/i.test(message))) {
      writeLog('[PAGE ' + level + '] ' + message);
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
        visibilityState: probe.visibilityState || document.visibilityState,
        online: probe.online !== false,
        networkChangedAt: Number(probe.networkChangedAt) || 0,
        networkEvent: probe.networkEvent || 'unknown',
        webSocketOpen: !!probe.webSocketOpen,
        webSocketOpenCount: Number(probe.webSocketOpenCount) || 0,
        core: probe.core || null,
        telemetry: probe.telemetry ? {
          sessionId: probe.telemetry.sessionId || null,
          scanCount: Number(probe.telemetry.scanCount) || 0,
          lastScanAt: Number(probe.telemetry.lastScanAt) || 0,
          lastScan: probe.telemetry.lastScan || null,
          perAssetScanCount: Object.keys(probe.telemetry.perAssetLastScan || {}).length,
          signalCount: Number(probe.telemetry.signalSequence) || 0,
          tradeCount: Number(probe.telemetry.tradeSequence) || 0
        } : null
      } : null,
      online: probe ? probe.online !== false : navigator.onLine !== false,
      webSocketOpen: openSocket || !!(probe && probe.webSocketOpen),
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
      selectedAccount,
      lastLoadError,
      profilePath: poSession && typeof poSession.getStoragePath === 'function'
        ? poSession.getStoragePath()
        : PARTITION,
      page: page
    },
    backgroundTestRunning: backgroundTestRunning,
    health: lastHealthSummary,
    statsDirectory: statsDirectory
  };
}

async function publishStatus() {
  if (statusBusy || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  statusBusy = true;
  try {
    const status = await getStatus();
    lastPageSnapshot = status.site && status.site.page ? status.site.page : null;
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

ipcMain.handle('app:open-account', async (_event, accountMode) => {
  const mode = String(accountMode || '').toUpperCase();
  const url = ACCOUNT_URLS[mode];
  if (!url) return { ok: false, reason: 'Неизвестный тип счёта.' };
  if (!siteWindow || siteWindow.isDestroyed()) {
    return { ok: false, reason: 'Окно Pocket Option не запущено.' };
  }

  selectedAccount = mode;
  lastLoadError = null;
  writeLog('Запрошено открытие ' + mode + '-счёта: ' + url);
  siteWindow.show();
  siteWindow.focus();
  try {
    await siteWindow.loadURL(url);
    return { ok: true, mode, url };
  } catch (error) {
    lastLoadError = {
      code: 'LOAD_URL_REJECTED',
      description: String(error),
      url,
      isMainFrame: true,
      at: new Date().toISOString()
    };
    writeLog('Не удалось открыть ' + mode + '-счёт: ' + String(error));
    void publishStatus();
    return { ok: false, reason: String(error) };
  }
});

ipcMain.handle('app:open-stats-folder', async () => {
  if (!statsDirectory) return { ok: false, error: 'Каталог статистики ещё не создан.' };
  fs.mkdirSync(statsDirectory, { recursive: true });
  const error = await shell.openPath(statsDirectory);
  return error ? { ok: false, error } : { ok: true, path: statsDirectory };
});

ipcMain.handle('app:restart', async () => {
  const page = await readPageProbe();
  const core = page && page.probe ? page.probe.core : null;
  if (core && (core.autoTrade || core.tradeBusy)) {
    return { ok: false, reason: 'Сначала останови автоторговлю и дождись завершения активной сделки. Перезапуск сейчас заблокирован.' };
  }
  writeLog('Запрошен перезапуск Electron. Анализатор будет остановлен, постоянный профиль сохранён.');
  if (process.env.PT_WATCHDOG === '1') {
    watchdogRestartRequested = true;
  } else {
    app.relaunch();
  }
  app.quit();
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

app.on('before-quit', event => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  appQuitting = true;
  void gracefulShutdown();
});

app.on('window-all-closed', () => {
  app.quit();
});
