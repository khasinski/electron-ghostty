'use strict';
// xterm-style facade, pty mode: the host owns the shell; the page only calls input() and reads the visible rows.
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (win) => {
  const ev = (c) => win.webContents.executeJavaScript(c);
  const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr); await sleep(50); } };
  await waitFor("window.term && term.cols > 2 && [...Array(term.rows).keys()].some((y) => (term.buffer.active.getLine(y)?.translateToString(true) || '').length > 0)");
  await ev("term.input('echo ghostty-pty-ok\\r'); 0");
  await waitFor("[...Array(term.rows).keys()].some((y) => term.buffer.active.getLine(y)?.translateToString(true) === 'ghostty-pty-ok')");
  await ev("window.__ex = null; term.onExit((s) => __ex = s); term.input('exit 3\\r'); 0");
  await waitFor('__ex !== null');
  assert.strictEqual(await ev('__ex'), 3);
  console.log('xterm facade (pty mode) ok');
};
