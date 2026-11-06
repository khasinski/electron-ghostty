'use strict';
// electron-ghostty: embed a libghostty-vt terminal in an Electron BrowserWindow.
//
//   // main process
//   const { attach, preloadPath } = require('electron-ghostty');
//   const win = new BrowserWindow({ webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true } });
//   const term = attach(win, { shell: '/bin/zsh', scrollbackLines: 100000 });
//   win.loadFile('index.html');          // the page loads  <script src=".../keymap.js"> + renderer.js  (see assetPath)
//
// The terminal core (PTY + libghostty-vt) runs in a utility process. The renderer only draws.
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');

/**
 * Start a terminal host process and hand the renderer a MessagePort once the page has loaded.
 * @param {Electron.BrowserWindow} win
 * @param {{shell?: string, args?: string[], cwd?: string, env?: object, scrollbackLines?: number, scrollbackBytes?: number}} [opts]
 * @returns {{kill(): void, host: Electron.UtilityProcess}}
 */
function attach(win, opts = {}) {
  const { utilityProcess, MessageChannelMain, shell } = require('electron');
  const host = utilityProcess.fork(path.join(appDir, 'host.js'), [], { serviceName: 'ghostty-host' });
  const { port1, port2 } = new MessageChannelMain();
  host.postMessage({ t: 'port', config: opts }, [port1]);
  const deliver = () => win.webContents.postMessage('term-port', null, [port2]);
  // attach() is normally called before loadFile()/loadURL(): isLoading() is still false then, so check for a loaded URL too.
  if (win.webContents.getURL() && !win.webContents.isLoading()) deliver(); else win.webContents.once('did-finish-load', deliver);
  // OSC 8 links are opened in the system browser, only for http(s)/mailto, and never as an in-app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  const kill = () => { try { host.kill(); } catch { /* already gone */ } };
  win.on('closed', kill);
  return { kill, host };
}

module.exports = {
  attach,
  /** Preload script that forwards the MessagePort into the page (works with sandbox + contextIsolation). */
  preloadPath: path.join(appDir, 'preload.js'),
  /** Absolute path of a renderer asset: 'renderer.js', 'keymap.js', 'index.html'. */
  assetPath: (name) => path.join(appDir, name),
};
