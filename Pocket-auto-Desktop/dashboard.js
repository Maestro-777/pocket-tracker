'use strict';

const byId = id => document.getElementById(id);
const logElement = byId('log');
let testRunning = false;

function setText(id, value) {
  byId(id).textContent = value == null || value === '' ? '—' : String(value);
}

function setPill(text, kind) {
  const pill = byId('overallState');
  pill.textContent = text;
  pill.className = 'pill ' + kind;
}

function appendLog(line) {
  logElement.textContent += '\n' + line;
  logElement.scrollTop = logElement.scrollHeight;
  const lines = logElement.textContent.split('\n');
  if (lines.length > 80) logElement.textContent = lines.slice(-80).join('\n');
}

function renderStatus(status) {
  if (!status) return;
  setText('appVersion', 'v' + status.appVersion);

  const ext = status.extension || {};
  setText('extensionState', ext.loaded ? 'Загружено' : 'Ошибка загрузки');
  setText('extensionInfo', ext.loaded ? (ext.name + ' · ' + ext.id) : (ext.error || 'Нет связи'));

  const site = status.site || {};
  const page = site.page || {};
  setText('siteState', !site.alive ? 'Остановлен' : site.loading ? 'Загрузка' : 'Открыт');
  setText('siteInfo', site.alive ? ((site.selectedAccount || 'DEMO') + ' · ' +
    (site.visible ? 'окно видно' : 'окно скрыто')) : 'Окно отсутствует');
  const loadError = site.lastLoadError;
  setText('siteLoadInfo', loadError
    ? 'Ошибка загрузки: ' + loadError.code + ' · ' + loadError.description + ' · ' + loadError.url
    : 'Текущий адрес: ' + ((page && page.url) || 'ожидание загрузки'));
  setText('engineState', page.engineLoaded ? 'Обнаружено' : 'Ожидание');
  setText('engineInfo', page.extensionInjected ? 'Скрипт расширения запущен' : 'Инъекция ещё не подтверждена');
  setText('socketState', page.webSocketOpen ? 'Подключён' : 'Ожидание');
  setText('socketInfo', 'Активных соединений: ' + (page.webSocketCount || 0));
  setText('accountState', page.accountMode || 'Не определён');

  if (page.probe) {
    const age = Math.max(0, Date.now() - page.probe.lastTickAt);
    setText('timerState', age < 3500 ? 'Работает' : 'Нет свежих тиков');
    setText('timerInfo', 'Тиков: ' + page.probe.ticks + ' · задержка: ' + age + ' мс');
  } else {
    setText('timerState', 'Не обнаружен');
    setText('timerInfo', 'Ожидание контрольного скрипта');
  }

  const core = page.probe && page.probe.core ? page.probe.core : {};
  const telemetry = page.probe && page.probe.telemetry ? page.probe.telemetry : {};
  const health = status.health || null;
  const healthPill = byId('autoHealthState');
  if (health) {
    healthPill.textContent = health.status || 'Проверено';
    healthPill.className = 'pill ' + (health.level || 'neutral');
    setText('healthTime', new Date(health.at).toLocaleString());
    setText('healthTimer', health.tickDelta == null
      ? 'Базовая проверка · таймер ' + (health.timerOk ? 'работает' : 'не отвечает')
      : 'Тиков за интервал: ' + health.tickDelta + ' · задержка ' + (health.timerAgeMs == null ? '—' : health.timerAgeMs + ' мс'));
  } else {
    healthPill.textContent = 'Ожидание проверки';
    healthPill.className = 'pill neutral';
    setText('healthTime', 'Ожидание');
    setText('healthTimer', 'Первая проверка через 20 секунд после запуска');
  }

  const transportOk = !!page.webSocketOpen || !!(page.probe && page.probe.webSocketOpen) ||
    (core.quoteAgeMs != null && core.quoteAgeMs <= 30000);
  setText('healthSocket', transportOk ? 'Подключение есть' : (page.online === false ? 'Нет сети' : 'Нет связи'));
  setText('healthQuoteAge', core.quoteAgeMs == null
    ? 'Котировки ещё не получены'
    : 'Последняя котировка: ' + (core.quoteAgeMs < 1000 ? core.quoteAgeMs + ' мс' : Math.round(core.quoteAgeMs / 1000) + ' сек. назад'));

  setText('healthEngine', !core.loaded ? 'Не обнаружено'
    : core.running ? 'Сканер активен' : 'Ядро загружено, сканер выключен');
  setText('healthAsset', core.asset ? 'Актив: ' + core.asset : 'Актив не определён');

  setText('healthScans', telemetry.scanCount || 0);
  setText('healthScanDelta', health && health.scanDelta != null
    ? 'Сканов за интервал: +' + health.scanDelta
    : 'Сканов за интервал: собирается база');
  setText('healthSignals', (telemetry.signalCount || 0) + ' / ' + (telemetry.tradeCount || 0));
  setText('profileState', status.site && status.site.profilePath ? 'Профиль сохранён' : 'Постоянная сессия');
  setText('statsPath', status.statsDirectory ? 'Файлы статистики: ' + status.statsDirectory : 'Папка статистики будет показана после запуска');

  const warnings = health
    ? (health.critical || []).concat(health.warnings || [])
    : [];
  const warningBox = byId('healthWarnings');
  warningBox.textContent = warnings.length
    ? warnings.join(' · ')
    : health ? 'Ошибок автоматической проверки не обнаружено.' : 'Первая автоматическая проверка ещё не выполнена.';
  warningBox.className = 'health-warnings ' + (health && health.level ? health.level : 'neutral');

  const throttleText = site.backgroundThrottling === false ? 'throttling выключен' : 'throttling включён/неизвестен';
  setText('visibilityState', (site.visible ? 'Окно видно' : 'Окно скрыто') +
    ' · visibility: ' + (page.visibilityState || '—') + ' · ' + throttleText);

  if (!ext.loaded) setPill('Нет расширения', 'bad');
  else if (!site.alive || site.loading) setPill('Подключение', 'neutral');
  else if (!page.extensionInjected || !page.engineLoaded) setPill('Проверка скриптов', 'neutral');
  else setPill('Страница и ядро подключены', 'good');

  byId('showSite').disabled = !site.alive || testRunning;
  byId('hideSite').disabled = !site.alive || !site.visible || testRunning;
  byId('reloadSite').disabled = !site.alive || testRunning;
  byId('runTest').disabled = !ext.loaded || !page.probe || testRunning;
}

function setTestResult(text, kind) {
  const el = byId('testResult');
  el.textContent = text;
  el.className = 'test-result ' + kind;
}

window.ptApp.onStatus(renderStatus);
window.ptApp.onLog(appendLog);
window.ptApp.onTestProgress(({ remaining }) => {
  setTestResult('Тест выполняется. Осталось примерно ' + remaining + ' сек.', 'neutral');
});

async function refreshStatus() {
  try {
    renderStatus(await window.ptApp.getStatus());
  } catch (error) {
    appendLog('Ошибка статуса: ' + String(error));
  }
}

byId('openDemo').addEventListener('click', async () => {
  setText('siteLoadInfo', 'Открываю DEMO-счёт...');
  const result = await window.ptApp.openAccount('DEMO');
  if (!result.ok) setText('siteLoadInfo', 'Не удалось открыть DEMO: ' + result.reason);
});
byId('openReal').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Открыть реальный счёт Pocket Option? Убедись, что не запускаешь торговлю случайно.'
  );
  if (!confirmed) return;
  setText('siteLoadInfo', 'Открываю REAL-счёт...');
  const result = await window.ptApp.openAccount('REAL');
  if (!result.ok) setText('siteLoadInfo', 'Не удалось открыть REAL: ' + result.reason);
});
byId('openStatsFolder').addEventListener('click', async () => {
  const result = await window.ptApp.openStatsFolder();
  if (!result.ok) setTestResult('Не удалось открыть статистику: ' + (result.error || 'ошибка'), 'bad');
});
byId('restartApp').addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Перезапустить Electron? Торговый анализатор будет остановлен, постоянный профиль авторизации сохранится.'
  );
  if (!confirmed) return;
  const result = await window.ptApp.restartApp();
  if (!result.ok) setTestResult('Перезапуск запрещён: ' + (result.reason || 'ошибка'), 'bad');
});
byId('showSite').addEventListener('click', () => window.ptApp.showSite());
byId('hideSite').addEventListener('click', () => window.ptApp.hideSite());
byId('reloadSite').addEventListener('click', async () => {
  setTestResult('Перезагрузка страницы...', 'neutral');
  await window.ptApp.reloadSite();
});
byId('runTest').addEventListener('click', async () => {
  if (testRunning) return;
  testRunning = true;
  byId('runTest').disabled = true;
  setTestResult('Окно Pocket Option будет скрыто. Идёт проверка 30 секунд...', 'neutral');
  await refreshStatus();
  try {
    const result = await window.ptApp.runBackgroundTest();
    if (result.passed) {
      setTestResult('ТЕСТ ПРОЙДЕН. ' + result.reason +
        ' Тиков за тест: ' + result.tickDelta +
        '; задержка последнего тика: ' + result.tickAgeMs + ' мс.' +
        (result.webSocketOpen ? ' WebSocket остаётся подключён.' : ' WebSocket пока не подключён.'), 'good');
    } else {
      setTestResult('ТЕСТ НЕ ПРОЙДЕН. ' + (result.reason || 'Неизвестная ошибка') +
        (result.tickDelta != null ? ' Тиков за тест: ' + result.tickDelta + '.' : ''), 'bad');
    }
  } catch (error) {
    setTestResult('Ошибка теста: ' + String(error), 'bad');
  } finally {
    testRunning = false;
    await refreshStatus();
  }
});

refreshStatus();
setInterval(refreshStatus, 2500);
