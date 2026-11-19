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
$('widget-mode').addEventListener('click', async () => { const s = await api.getStatus(); const target = s.account.type === 'real' ? 'DEMO' : 'REAL'; await api.switchAccount(target); });
$('widget-hide').addEventListener('click', () => api.toggleWidget());
$('widget-site').addEventListener('click', async () => { const s = await api.getStatus(); if (s.site.running) await api.showSite(); else await api.launchSite(); });
api.getStatus().then(render); api.onStatus(render);
