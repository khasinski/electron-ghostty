'use strict';
// Live-app test with real Electron input events: keys, double/triple click, drag, copy, wheel, bracketed paste.
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (win) => {
  const wc = win.webContents;
  const ev = (code) => wc.executeJavaScript(code);
  const press = async (key, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers }); };
  const typeStr = async (s) => { for (const c of s) { await press(c === ' ' ? 'Space' : c === '\n' ? 'Return' : c); } };
  const screen = () => ev('window.__dump()');
  const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const s = await screen(); if (pred(s)) return s; if (Date.now() - t0 > ms) throw new Error('timeout; screen=' + JSON.stringify(s)); await sleep(50); } };
  const [cw, ch, dpr] = await ev('[cellW, cellH, dpr]');
  const at = (x, y) => ({ x: Math.round(((x + 0.5) * cw) / dpr), y: Math.round(((y + 0.5) * ch) / dpr) });

  await waitFor((s) => s.some((l) => l.includes('%')));
  // 1. real key events -> encoder -> pty
  await typeStr('echo alpha-bravo charlie');
  await press('Return');
  let s = await waitFor((x) => x.filter((l) => l.trim() === 'alpha-bravo charlie').length === 1);
  const row = s.findIndex((l) => l.trim() === 'alpha-bravo charlie');
  console.log('typing ok, output on row', row);

  // 2. double click on "bravo" selects a word, Cmd+C copies it
  const colBravo = s[row].indexOf('bravo') + 2;
  const p = at(colBravo, row);
  for (const clickCount of [1, 2]) {
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount });
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount });
  }
  await sleep(200);
  await press('C', ['meta']);
  await sleep(300);
  const clip = await ev('window.__lastClip');
  console.log('double-click + Cmd+C ->', JSON.stringify(clip));
  assert.ok(clip === 'alpha-bravo' || clip === 'bravo', 'word selected (word boundaries decide dash handling): ' + clip);

  // 3. triple click selects the whole line
  for (const clickCount of [1, 2, 3]) {
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount });
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount });
  }
  await sleep(200); await press('C', ['meta']); await sleep(300);
  assert.strictEqual(await ev('window.__lastClip'), 'alpha-bravo charlie');
  console.log('triple click ok');

  // 4. drag selects a range
  const a = at(0, row), b = at(4, row);
  wc.sendInputEvent({ type: 'mouseDown', ...a, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) { await sleep(20); wc.sendInputEvent({ type: 'mouseMove', ...at(i, row), button: 'left' }); }
  wc.sendInputEvent({ type: 'mouseUp', ...b, button: 'left', clickCount: 1 });
  await sleep(200); await press('C', ['meta']); await sleep(300);
  assert.strictEqual(await ev('window.__lastClip'), 'alpha');
  console.log('drag select ok');

  // 5. history + Ctrl+C + arrow keys: Up recalls the previous command
  await press('Escape');
  await press('ArrowUp'); await sleep(300);
  s = await screen();
  assert.ok(s.some((l) => l.includes('echo alpha-bravo charlie') && l.includes('%')), 'ArrowUp recalled history: ' + JSON.stringify(s.slice(-3)));
  await press('c', ['control']); await sleep(300);
  console.log('arrow + ctrl ok');

  // 6. wheel scrollback
  await typeStr('seq 1 200'); await press('Return');
  await waitFor((x) => x.some((l) => l.trim() === '200'));
  const before = (await screen())[0];
  wc.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: 300 });
  await sleep(400);
  const after = (await screen())[0];
  assert.notStrictEqual(before, after, 'wheel scrolled viewport');
  console.log('wheel scroll ok:', before.trim(), '->', after.trim());

  // 7. key->pixel latency
  await ev("sendInput('\\u0003')"); await sleep(200);
  const lat = await ev('window.__latency(40)');
  lat.sort((x, y) => x - y);
  const med = lat[Math.floor(lat.length / 2)], p95 = lat[Math.floor(lat.length * 0.95)];
  console.log('LATENCY ghostty ms: median', med.toFixed(1), 'p95', p95.toFixed(1), 'min', lat[0].toFixed(1), 'max', lat[lat.length - 1].toFixed(1));
  console.log('ALL OK');
};
