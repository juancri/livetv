const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livetv', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  findLive: (channel) => ipcRenderer.invoke('find-live', channel),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  quit: () => ipcRenderer.send('quit'),
});
