const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livetv', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  findLives: (channel) => ipcRenderer.invoke('find-lives', channel),
  findMarket: (value) => ipcRenderer.invoke('find-market', value),
  priceHistory: (tokenId) => ipcRenderer.invoke('price-history', tokenId),
  addStream: (args) => ipcRenderer.invoke('add-stream', args),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  quit: () => ipcRenderer.send('quit'),
});
