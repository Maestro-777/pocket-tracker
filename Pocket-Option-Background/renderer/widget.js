'use strict';
const api = window.pocketApp;
const $ = id => document.getElementById(id);
function render(s) {
  if (!s) return;
  $('widget-mode').textContent = (s.account.type || 'demo').toUpperCase();
  $('widget-balance').textContent = s.account.balance == null ? '—' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(s.account.balance) + (s.account.currency ? ' ' + s.account.currency : '');
  $('widget-connection').textContent = s.site.running ? (s.account.stale ? 'Нет свежих данных' : 'Подключено') : 'Сайт не запущен';
  $('widget-dot').className = s.site.running && !s.account.stale ? 'online' : '';
}
$('widget-hide').addEventListener('click', () => api.toggleWidget());
$('widget-site').addEventListener('click', () => api.showSite());
api.getStatus().then(render); api.onStatus(render);
