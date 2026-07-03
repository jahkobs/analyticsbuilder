'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Narrow, promise-based bridge. The renderer never sees Node APIs.
contextBridge.exposeInMainWorld('innovatia', {
  appendAudit: (event) => ipcRenderer.invoke('store:appendAudit', event),
  getAudit: () => ipcRenderer.invoke('store:getAudit'),
  getDashboards: () => ipcRenderer.invoke('store:getDashboards'),
  saveDashboards: (d) => ipcRenderer.invoke('store:saveDashboards', d),
  getReleases: () => ipcRenderer.invoke('store:getReleases'),
  saveReleases: (r) => ipcRenderer.invoke('store:saveReleases', r),
  getSettings: () => ipcRenderer.invoke('store:getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('store:saveSettings', s),
  exportFile: (payload) => ipcRenderer.invoke('app:exportFile', payload),
  pickFile: (opts) => ipcRenderer.invoke('app:pickFile', opts),
  httpTest: (opts) => ipcRenderer.invoke('conn:httpTest', opts),
  version: () => ipcRenderer.invoke('app:version')
});
