'use strict';
// Hand the MessagePort to the page without exposing Node or ipcRenderer.
const { ipcRenderer } = require('electron');
ipcRenderer.on('term-port', (e) => window.postMessage('term-port', '*', e.ports));
