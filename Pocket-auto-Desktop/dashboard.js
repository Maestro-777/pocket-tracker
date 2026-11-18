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
