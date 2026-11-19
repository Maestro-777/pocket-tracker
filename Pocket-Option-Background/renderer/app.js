'use strict';
const api = window.pocketApp;
const $ = id => document.getElementById(id);
let logs = [];
const pages = { home: 'Главная', monitor: 'Мониторинг', logs: 'Журналы', settings: 'Настройки', updates: 'Обновления' };
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}
function fmtMoney(value, currency) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + (currency ? ' ' + currency : '');
}
function fmtUptime(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
function showPage(name) {
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + name));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === name));
  $('page-title').textContent = pages[name];
  if (name === 'logs') renderLogs();
  if (name === 'settings') loadSettings();
}
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.goto)));

function renderStatus(status) {
  if (!status) return;
  $('app-version').textContent = status.appVersion;
  $('uptime-value').textContent = fmtUptime(status.uptimeSeconds);
  $('site-title').textContent = !status.site.running ? 'Сайт не запущен' : status.site.loading ? 'Загрузка Pocket Option…' : status.site.visible ? 'Pocket Option открыт' : 'Pocket Option работает в фоне';
  $('site-subtitle').textContent = status.site.running ? (status.site.visible ? 'Окно сайта доступно на рабочем столе' : 'Окно скрыто, профиль браузера сохранён') : 'Запусти сайт отдельной кнопкой — он не открывается автоматически.';
  $('launch-site').textContent = status.site.running ? 'Открыть Pocket Option' : 'Запустить Pocket Option';
  $('reload-site').disabled = !status.site.running;
  $('show-site').disabled = !status.site.running;
  $('hide-site').disabled = !status.site.running;
  $('account-mode').textContent = (status.account.type || 'demo').toUpperCase();
  $('balance-value').textContent = fmtMoney(status.account.balance, status.account.currency);
  $('balance-updated').textContent = status.account.updatedAt ? 'Обновлено ' + new Date(status.account.updatedAt).toLocaleTimeString('ru-RU') : 'Нет подтверждённых данных сайта';
  $('account-hint').textContent = status.account.stale ? 'Ожидание свежего подтверждения от Pocket Option' : 'Режим подтверждён адаптером сайта';
  $('widget-state').textContent = status.widgetVisible ? 'Включён' : 'Выключен';
  $('internet-state').textContent = status.network.online === null ? 'Проверка…' : status.network.online ? 'Доступен' : 'Нет соединения';
  $('po-state').textContent = !status.site.running ? 'Не запущен' : status.site.loading ? 'Загружается' : status.account.stale ? 'Нет свежих данных' : 'Подключён';
  $('balance-age').textContent = status.account.updatedAt ? Math.round((Date.now() - status.account.updatedAt) / 1000) + ' сек. назад' : '—';
  $('connection-pill').textContent = status.site.running ? (status.account.stale ? 'Ожидание данных' : 'Подключено') : 'Нет данных';
  $('network-pill').textContent = 'Сеть: ' + (status.network.online === null ? 'проверка' : status.network.online ? 'доступна' : 'нет связи');
  $('side-status').textContent = status.site.running ? (status.account.stale ? 'Нет свежих данных' : 'Pocket Option подключён') : 'Сайт не запущен';
  $('side-dot').className = status.site.running && !status.account.stale ? 'online' : '';
  $('site-dot').className = status.site.running && !status.account.stale ? 'status-dot online' : 'status-dot';
  $('demo-btn').classList.toggle('active', status.account.type === 'demo');
  $('real-btn').classList.toggle('active', status.account.type === 'real');
  $('real-btn').classList.toggle('real', status.account.type === 'real');
  if (status.update) {
    $('update-message').textContent = status.update.message || '';
    $('update-progress').style.width = (status.update.progress || 0) + '%';
    $('download-update').disabled = status.update.status !== 'available';
    $('install-update').disabled = status.update.status !== 'downloaded';
    if (status.update.version) $('update-version').textContent = status.update.version;
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function logHtml(row) {
  const time = row.at ? new Date(row.at).toLocaleTimeString('ru-RU') : '—';
  return '<div class="log-entry ' + (row.level || 'info') + '"><span class="level">' + escapeHtml(row.level || 'info') + '</span><time>' + time + '</time><span>' + escapeHtml(row.message || '') + '</span></div>';
}
function renderRecent() {
  $('recent-logs').innerHTML = logs.slice(-5).reverse().map(logHtml).join('') || '<div class="empty">Событий пока нет</div>';
}
function renderLogs() {
  const query = $('log-filter').value.toLowerCase(), level = $('log-level').value;
  const rows = logs.filter(row => (level === 'all' || row.level === level) && (!query || (row.message + ' ' + JSON.stringify(row.data || {})).toLowerCase().includes(query)));
  $('all-logs').innerHTML = rows.slice().reverse().map(logHtml).join('') || '<div class="empty">Ничего не найдено</div>';
}
function addLog(row) {
  logs.push(row); if (logs.length > 1200) logs = logs.slice(-1200);
  renderRecent(); if ($('page-logs').classList.contains('active')) renderLogs();
}
async function loadSettings() {
  const value = await api.getSettings();
  $('setting-widget').checked = !!value.showMiniWidget;
  $('setting-interval').value = value.monitorIntervalMinutes || 5;
  $('setting-attempts').value = value.reconnectAttemptsBeforeReload || 3;
  $('setting-delay').value = value.reconnectDelaySeconds || 30;
  $('setting-max-reloads').value = value.maxReloadsPer10Minutes || 3;
  $('setting-updates').checked = !!value.autoCheckUpdates;
}
function renderCheck(result) {
  $('check-summary').textContent = (result.passed ? 'Проверка пройдена' : 'Есть замечания') + ' · ' + new Date(result.at).toLocaleString('ru-RU');
  $('check-list').innerHTML = result.checks.map(check =>
    '<div class="check-row"><div><b>' + escapeHtml(check.name) + '</b><br><small>' + escapeHtml(check.detail) +
    '</small></div><b class="' + (check.ok ? 'pass' : 'fail') + '">' + (check.ok ? 'OK' : 'ПРОБЛЕМА') + '</b></div>'
  ).join('');
}

$('launch-site').addEventListener('click', async () => {
  const status = await api.getStatus();
  if (status.site.running) await api.showSite(); else await api.launchSite();
});
$('show-site').addEventListener('click', () => api.showSite());
$('hide-site').addEventListener('click', () => api.hideSite());
$('reload-site').addEventListener('click', async () => { await api.reloadSite(); toast('Перезагрузка страницы запущена'); });
async function switchMode(mode) {
  const result = await api.switchAccount(mode);
  if (result.ok) toast('Режим ' + mode + ' подтверждён сайтом');
  else if (!result.cancelled) toast(result.reason || 'Не удалось переключить счёт');
}
$('demo-btn').addEventListener('click', () => switchMode('DEMO'));
$('real-btn').addEventListener('click', () => switchMode('REAL'));
$('refresh-btn').addEventListener('click', async () => renderStatus(await api.getStatus()));
$('run-check').addEventListener('click', async () => renderCheck(await api.runCheck()));
$('widget-state').parentElement.addEventListener('click', () => api.toggleWidget());
$('save-settings').addEventListener('click', async () => {
  const value = {
    showMiniWidget: $('setting-widget').checked,
    monitorIntervalMinutes: Math.max(5, Math.min(30, Number($('setting-interval').value) || 5)),
    reconnectAttemptsBeforeReload: Math.max(1, Math.min(10, Number($('setting-attempts').value) || 3)),
    reconnectDelaySeconds: Math.max(5, Math.min(300, Number($('setting-delay').value) || 30)),
    maxReloadsPer10Minutes: Math.max(1, Math.min(5, Number($('setting-max-reloads').value) || 3)),
    autoCheckUpdates: $('setting-updates').checked
  };
  await api.saveSettings(value); toast('Настройки сохранены');
});
$('export-logs').addEventListener('click', async () => {
  const result = await api.exportLogs();
  toast(result.ok ? 'Архив журналов сохранён' : result.cancelled ? 'Экспорт отменён' : 'Ошибка экспорта');
});
$('log-filter').addEventListener('input', renderLogs);
$('log-level').addEventListener('change', renderLogs);
$('check-updates').addEventListener('click', async () => {
  const result = await api.checkUpdates(); if (!result.ok) toast(result.reason || 'Проверка не удалась');
});
$('download-update').addEventListener('click', async () => {
  const result = await api.downloadUpdate(); if (!result.ok) toast(result.reason || 'Ошибка загрузки');
});
$('install-update').addEventListener('click', () => api.installUpdate());

api.onStatus(renderStatus);
api.onLog(addLog);
api.onCheckResult(renderCheck);
Promise.all([api.getStatus(), api.readLogs()]).then(([status, history]) => {
  renderStatus(status); logs = history || []; renderRecent();
}).catch(error => toast('Не удалось загрузить состояние: ' + error.message));
