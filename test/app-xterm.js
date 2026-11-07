'use strict';
// xterm-style facade, external mode (page feeds bytes, like an app with its own PTY). Run with GHOSTTY_PAGE=xterm-demo.html.
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (win) => {
  const wc = win.webContents;
  const ev = (c) => wc.executeJavaScript(c);
  const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr); await sleep(40); } };
  const press = (key) => { wc.sendInputEvent({ type: 'keyDown', keyCode: key }); wc.sendInputEvent({ type: 'keyUp', keyCode: key }); };

  await waitFor('window.term && term.cols > 2');
  await ev('window.__got = []; window.__ev = {}; term.onData((d) => __got.push(d)); term.onTitleChange((t) => __ev.title = t); term.onBell(() => __ev.bell = true); term.onResize((r) => __ev.resize = r); term.onSelectionChange(() => __ev.sel = (__ev.sel || 0) + 1); term.onScroll((p) => __ev.scroll = p); 0');

  // write(): callback fires after the host parsed the bytes; visible rows readable through buffer.active
  assert.strictEqual(await ev("new Promise((r) => term.write('hello world\\r\\nsecond line\\r\\n', () => r('acked')))"), 'acked');
  assert.strictEqual(await ev("term.buffer.active.getLine(0).translateToString(true)"), 'electron-ghostty, xterm-style API (external mode)');
  assert.strictEqual(await ev("term.buffer.active.getLine(2).translateToString(true)"), 'second line');
  assert.strictEqual(await ev('term.buffer.active.cursorY'), 3);

  // typing goes through libghostty's encoder and comes back through onData (the demo echoes it)
  press('x'); press('Return');
  await waitFor("__got.join('').includes('x')");
  press('Up');
  await waitFor("__got.join('').includes('\\x1b[A')");
  console.log('onData ok:', JSON.stringify(await ev('__got')));

  // events from the parser thread
  await ev("term.write('\\x1b]0;mytitle\\x07\\x07'); 0");
  await waitFor("__ev.title === 'mytitle' && __ev.bell === true");

  // resize follows the container (FitAddon semantics) and fires onResize
  const before = await ev('[term.cols, term.rows]');
  await ev("document.getElementById('t').style.right = '500px'; 0");
  await waitFor(`term.cols < ${before[0]} && __ev.resize && __ev.resize.cols === term.cols`);
  console.log('resize ok:', before, '->', await ev('[term.cols, term.rows]'));

  // selection + cached text
  await ev('term.selectAll(); 0');
  await waitFor("__ev.sel >= 1 && term.hasSelection()");
  assert((await ev('term.getSelection()')).includes('hello world'));
  await ev('term.clearSelection(); 0');
  await waitFor('!term.hasSelection()');

  // scrollback lives in the host; the page sees positions only
  await ev("term.write(Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\\r\\n') + '\\r\\n'); 0");
  await waitFor("term.buffer.active.length > term.rows");
  const vy0 = await ev('term.buffer.active.viewportY');
  await ev('term.scrollLines(-20); 0');
  await waitFor(`term.buffer.active.viewportY < ${vy0}`);
  assert.strictEqual(await ev(`typeof term.buffer.active.getLine(${vy0} + term.rows - 1)`), 'undefined');   // rows outside the viewport are not mirrored into the page
  await ev('term.scrollToBottom(); 0');
  await waitFor(`term.buffer.active.viewportY === ${vy0}`);

  // theme at runtime
  await ev("term.options.theme = { background: '#ff0000', foreground: '#ffffff' }; 0");
  await sleep(500);
  const cap = await wc.capturePage(), bmp = cap.toBitmap(), cw = Math.round(Math.sqrt(bmp.length / 4 * cap.getAspectRatio()));
  const o = (cw * 600 + 300) * 4;
  assert(bmp[o + 2] > 200 && bmp[o + 1] < 60 && bmp[o] < 60, 'background turned red: ' + [bmp[o + 2], bmp[o + 1], bmp[o]]);

  // everything that cannot keep the performance model must say so
  for (const code of ["term.registerOscHandler(1, () => true)", "term.parser.registerCsiHandler({ final: 'm' }, () => true)", "term.buffer.normal", "term.registerMarker()", "term.unicode", "term.registerDecoration({})", "new ghostty.SearchAddon().activate(term)"]) {
    const msg = await ev(`(() => { try { ${code}; return 'no error'; } catch (e) { return e.message; } })()`);
    assert(/not implemented/.test(msg), code + ' -> ' + msg);
  }
  await ev('term.dispose(); 0');
  assert.strictEqual(await ev("document.querySelectorAll('canvas').length"), 0);
  console.log('xterm facade (external mode) ok');
};
