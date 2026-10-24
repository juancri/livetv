const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livetv', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  findLives: (channel) => ipcRenderer.invoke('find-lives', channel),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  quit: () => ipcRenderer.send('quit'),
});
