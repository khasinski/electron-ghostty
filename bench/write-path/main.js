'use strict';
// Write-path benchmark: the app already has the bytes (its own PTY, ssh, a file) and calls term.write(chunk).
// xterm.js 6 + WebGL vs the electron-ghostty xterm-style facade (external mode), same window, same corpus, same chunking
// (64 KB, each chunk in its own task like IPC deliveries). No PTY in either: this isolates the terminal's write path.
//   ENGINE=xterm|ghostty BENCH=1 npx electron bench/write-path/main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { treeFootprint } = require('../e2e/harness');
const ENGINE = process.env.ENGINE || 'ghostty';
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (app.dock) app.dock.hide();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const web = { backgroundThrottling: false, webSecurity: false };   // webSecurity off only so the bench page can fetch() the corpus from file://
  if (ENGINE === 'ghostty') Object.assign(web, { preload: path.join(__dirname, '..', '..', 'app', 'preload.js'), contextIsolation: true, sandbox: true });
  const win = new BrowserWindow({ show: false, width: 1000, height: 640, webPreferences: web });
  if (ENGINE === 'ghostty') require('../../lib').attach(win, {});
  await win.loadFile(path.join(__dirname, ENGINE + '.html'), process.env.NOOP ? { search: 'noop' } : undefined);
  await win.webContents.executeJavaScript('window.__ready'); await sleep(2500);
  const idleF = treeFootprint(app), idle = idleF.total;
  const mb = fs.statSync(path.join(__dirname, '..', 'e2e', 'corpus.txt')).size / 1048576;
  const secs = await win.webContents.executeJavaScript('window.__run()');
  const lines = await win.webContents.executeJavaScript('window.__lines()');
  const after = treeFootprint(app).total;
  await sleep(6000);
  const sf = treeFootprint(app), settled = sf.total;
  console.log('RESULT ' + JSON.stringify({ engine: ENGINE + (process.env.NOOP ? '(noop)' : ''), seconds: +secs.toFixed(2), MBps: +(mb / secs).toFixed(1), bufferLines: lines, idleMB: idle, afterMB: after, settledMB: settled, idleParts: idleF.parts, settledParts: sf.parts }));
  app.quit();
});
