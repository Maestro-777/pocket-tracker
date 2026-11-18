'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ptApp', {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  showSite: () => ipcRenderer.invoke('app:show-site'),
  openAccount: mode => ipcRenderer.invoke('app:open-account', mode),
  hideSite: () => ipcRenderer.invoke('app:hide-site'),
  reloadSite: () => ipcRenderer.invoke('app:reload-site'),
  runBackgroundTest: () => ipcRenderer.invoke('app:background-test'),
  openStatsFolder: () => ipcRenderer.invoke('app:open-stats-folder'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  onStatus: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:status', listener);
    return () => ipcRenderer.removeListener('app:status', listener);
  },
  onLog: callback => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('app:log', listener);
    return () => ipcRenderer.removeListener('app:log', listener);
  },
  onTestProgress: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:test-progress', listener);
    return () => ipcRenderer.removeListener('app:test-progress', listener);
  }
});
