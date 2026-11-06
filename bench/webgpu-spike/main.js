// Spike: same cell-grid draw (full-screen triangle, per-pixel cell lookup + glyph atlas sample, per-frame grid upload)
// in WebGL2 vs WebGPU, hidden window. Reports GPU time (timer query / timestamp-query) and CPU submit time.
const { app, BrowserWindow } = require('electron');
app.dock && app.dock.hide();
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 640, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(__dirname + '/index.html');
  const r = await win.webContents.executeJavaScript('window.run()');
  console.log(JSON.stringify(r, null, 1));
  app.quit();
});
