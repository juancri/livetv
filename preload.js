const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livetv', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  quit: () => ipcRenderer.send('quit'),
});
