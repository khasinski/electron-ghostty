'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

if (process.env.BENCH || process.env.GHOSTTY_SCRIPT) {   // benchmark only: an occluded window must keep painting, or the probe measures Chromium's throttling
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  if (app.dock) app.dock.hide();   // headless run: no Dock icon, no Space switching
}
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: !(process.env.BENCH || process.env.GHOSTTY_SELFTEST || process.env.GHOSTTY_SCRIPT), width: 1000, height: 640, backgroundColor: '#1e1e2e',
    webPreferences: { backgroundThrottling: !(process.env.BENCH || process.env.GHOSTTY_SCRIPT), preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // The terminal core runs in its own process: PTY bytes never reach main or the renderer.
  require('../lib').attach(win, { osc52: process.env.GHOSTTY_OSC52 || 'deny' });            // same API an embedding app uses
  win.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.BENCH) {
    win.webContents.once('did-finish-load', () => require('../bench/e2e/harness').run(app, win, {
      label: 'electron-ghostty (libghostty-vt + WebGL2)',
      send: (s) => win.webContents.executeJavaScript(`sendInput(${JSON.stringify(s)})`),
      isDoneExpr: "window.__dump().some((l) => l.trim() === '__DONE__')",
    }));
  }
  if (process.env.GHOSTTY_SCRIPT) {   // test hook: run an async script against the live window
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      Promise.resolve(require(process.env.GHOSTTY_SCRIPT)(win, app)).catch((e) => { console.error('SCRIPT FAILED', e); process.exitCode = 1; }).finally(() => app.quit());
    }, 1500));
  }
  if (process.env.GHOSTTY_SELFTEST) {
    // Drive the real app: type a command, wait, screenshot, report renderer stats, quit.
    const fs = require('fs');
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const send = (s) => win.webContents.executeJavaScript(`sendInput(${JSON.stringify(s)})`);
      await send("printf '\\033[1;31mred\\033[0m \\033[4mundr\\033[0m \\033[48;2;0;80;200m blue \\033[0m \\u4f60\\u597d\\n'; ls --color=never / | head -5; echo ready\r");
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.GHOSTTY_SELFTEST, img.toPNG());
        console.log('screen', JSON.stringify(await win.webContents.executeJavaScript('window.__dump()'), null, 1));
        console.log('stats', JSON.stringify(await win.webContents.executeJavaScript('window.__ghostty')));
        app.quit();
      }, 4000);
    }, 1500));
  }
  if (process.env.GHOSTTY_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
});
app.on('window-all-closed', () => app.quit());
