'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const api = {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  launchSite: () => ipcRenderer.invoke('app:launch-site'),
  showSite: () => ipcRenderer.invoke('app:show-site'),
  hideSite: () => ipcRenderer.invoke('app:hide-site'),
  reloadSite: () => ipcRenderer.invoke('app:reload-site'),
  switchAccount: mode => ipcRenderer.invoke('app:account:switch', mode),
  toggleWidget: () => ipcRenderer.invoke('app:toggle-widget'),
  getSettings: () => ipcRenderer.invoke('app:settings:get'),
  saveSettings: value => ipcRenderer.invoke('app:settings:save', value),
  runCheck: () => ipcRenderer.invoke('app:run-check'),
  readLogs: () => ipcRenderer.invoke('app:logs:read'),
  exportLogs: () => ipcRenderer.invoke('app:logs:export'),
  checkUpdates: () => ipcRenderer.invoke('app:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update:download'),
  installUpdate: () => ipcRenderer.invoke('app:update:install'),
  onStatus: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:status', h); return () => ipcRenderer.removeListener('app:status', h); },
  onLog: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:log', h); return () => ipcRenderer.removeListener('app:log', h); },
  onCheckResult: fn => { const h = (_e, v) => fn(v); ipcRenderer.on('app:check-result', h); return () => ipcRenderer.removeListener('app:check-result', h); }
};
contextBridge.exposeInMainWorld('pocketApp', api);
