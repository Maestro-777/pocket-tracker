'use strict';
const { ipcRenderer } = require('electron');
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'PT_PO_BALANCE') return;
  const balance = Number(data.balance);
  if (!['demo', 'real'].includes(data.accountType) || !Number.isFinite(balance) || balance < 0) return;
  ipcRenderer.send('site:balance', {
    accountType: data.accountType, balance,
    currency: String(data.currency || '').slice(0, 8),
    ts: Number(data.ts) || Date.now()
  });
});
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data && event.data.type === 'PT_PO_LOG') ipcRenderer.send('site:log', { message: String(event.data.message || '').slice(0, 300), level: event.data.level });
});
