'use strict';
// Panes (one GL context, one atlas), OSC 8 hyperlinks via Cmd+click, OSC 52 clipboard policy.
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (win) => {
  const wc = win.webContents;
  const ev = (c) => wc.executeJavaScript(c);
  const press = (key, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers }); };
  const typeStr = (s) => { for (const c of s) press(c === ' ' ? 'Space' : c); };
  const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
  const inject = (str) => ev(`sendInput(${JSON.stringify(str)}); 0`);
  const text = (id) => ev(`window.__dump(${id})`);
  await waitFor(async () => (await text(1)).some((l) => l.includes('%')));

  // ---- two panes, independent shells
  press('D', ['meta']);
  await waitFor(async () => (await ev('window.__panes()')).length === 2);
  await waitFor(async () => (await text(2)).some((l) => l.includes('%')));
  typeStr('echo second-pane'); press('Return');
  await waitFor(async () => (await text(2)).some((l) => l.trim() === 'second-pane'));
  press('[', ['meta']);                                  // focus back to pane 1
  await sleep(100);
  typeStr('echo first-pane'); press('Return');
  await waitFor(async () => (await text(1)).some((l) => l.trim() === 'first-pane'));
  assert.ok(!(await text(1)).some((l) => l.includes('second-pane') && !l.includes('echo')), 'pane 1 has no pane 2 output');
  assert.ok(!(await text(2)).some((l) => l.trim() === 'first-pane'), 'pane 2 has no pane 1 output');
  const panes = await ev('window.__panes()');
  console.log('panes ok:', JSON.stringify(panes.map((p) => [p.id, p.cols + 'x' + p.rows, p.focused])));
  assert.ok(panes[0].rect.x + panes[0].rect.w < panes[1].rect.x, 'panes do not overlap');

  // ---- OSC 8 hyperlink: Cmd+click on the link text asks the host for the URI and opens it
  await ev("window.__opened = null; window.open = (u) => { window.__opened = u; }; 0");
  await inject("printf '\\033]8;;https://example.com/x\\033\\\\LINKTEXT\\033]8;;\\033\\\\ plain\\n'\r");
  const s1 = await waitFor(async () => { const t = await text(1); return t.some((l) => l.startsWith('LINKTEXT')) && t; });
  const row = s1.findIndex((l) => l.startsWith('LINKTEXT'));
  const [cw, ch, dpr] = await ev('[cellW, cellH, dpr]');
  const p1 = (await ev('window.__panes()'))[0];
  const at = (col) => ({ x: Math.round(((p1.rect.x + (col + 0.5) * cw)) / dpr), y: Math.round(((row + 0.5) * ch) / dpr) });
  wc.sendInputEvent({ type: 'mouseDown', ...at(2), button: 'left', clickCount: 1, modifiers: ['meta'] });
  wc.sendInputEvent({ type: 'mouseUp', ...at(2), button: 'left', clickCount: 1, modifiers: ['meta'] });
  await waitFor(async () => ev('window.__opened || window.__lastLink').then((v) => v || null), 4000).catch(async () => { throw new Error('no link event; lastLink=' + (await ev('window.__lastLink')) + ' screen=' + JSON.stringify(await text(1))); });
  assert.strictEqual(await ev('window.__opened'), 'https://example.com/x');
  console.log('OSC 8 link ok');
  // a click on non-link text opens nothing
  await ev('window.__opened = null; 0');
  wc.sendInputEvent({ type: 'mouseDown', ...at(12), button: 'left', clickCount: 1, modifiers: ['meta'] });
  wc.sendInputEvent({ type: 'mouseUp', ...at(12), button: 'left', clickCount: 1, modifiers: ['meta'] });
  await sleep(300);
  assert.strictEqual(await ev('window.__opened'), null);

  // ---- OSC 52: policy decides. deny (default) must not touch the clipboard; allow forwards text/plain
  const mode = process.env.GHOSTTY_OSC52 || 'deny';
  await ev('window.__lastOsc52 = undefined; 0');
  await inject("printf '\\033]52;c;aGVsbG8tb3NjNTI=\\007'\r");
  await sleep(800);
  const got = await ev('window.__lastOsc52');
  if (mode === 'allow') assert.strictEqual(got, 'hello-osc52'); else assert.strictEqual(got, undefined);
  console.log('OSC 52 policy', mode, 'ok');

  // ---- close pane 2: layout returns to one pane
  press('W', ['meta']);                                 // closes the focused (first) pane
  await waitFor(async () => (await ev('window.__panes()')).length === 1);
  console.log('close pane ok');
  console.log('ALL OK');
};
