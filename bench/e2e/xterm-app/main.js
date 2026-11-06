'use strict';
// Baseline: the same Electron shell with xterm.js (WebGL addon). PTY comes from node-pty
// (as in VS Code and friends), data crosses main -> renderer over IPC like a typical xterm.js integration.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const COLS = +process.env.BENCH_COLS || 118, ROWS = +process.env.BENCH_ROWS || 40;

if (process.env.BENCH || process.env.LATENCY) {   // benchmark only: an occluded window must keep painting, or the probe measures Chromium's throttling
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  if (app.dock) app.dock.hide();   // headless run: no Dock icon, no Space switching
}
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: !(process.env.BENCH || process.env.LATENCY), width: 1000, height: 640, webPreferences: { backgroundThrottling: !(process.env.BENCH || process.env.LATENCY), preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  const pty = require('node-pty').spawn('/bin/zsh', ['-l'], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.env.HOME, env: process.env });
  pty.onData((d) => { if (!win.isDestroyed()) win.webContents.send('data', d); });
  ipcMain.on('write', (_e, d) => pty.write(d));
  win.webContents.on('console-message', (_e, ...a) => console.log('[renderer]', JSON.stringify(a).slice(0, 300)));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => pty.kill());
  win.webContents.once('did-finish-load', () => {
    if (process.env.LATENCY) setTimeout(async () => {
      const lat = (await win.webContents.executeJavaScript('window.__latency(40)')).sort((a, b) => a - b);
      console.log('LATENCY xterm ms: median', lat[20].toFixed(1), 'p95', lat[38].toFixed(1), 'min', lat[0].toFixed(1), 'max', lat[39].toFixed(1));
      app.quit();
    }, 4000);
    if (process.env.BENCH) require('../harness').run(app, win, {
      label: 'xterm.js ' + require('@xterm/xterm/package.json').version + ' + webgl',
      send: (s) => win.webContents.executeJavaScript(`window.api.write(${JSON.stringify(s)})`),
      isDoneExpr: 'window.__isDone()',
    });
  });
});
app.on('window-all-closed', () => app.quit());
