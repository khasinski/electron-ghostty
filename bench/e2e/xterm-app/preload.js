'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let onData = null;
contextBridge.exposeInMainWorld('api', {
  onData: (cb) => { onData = cb; ipcRenderer.on('data', (_e, d) => cb(d)); },
  write: (d) => ipcRenderer.send('write', d),
});
