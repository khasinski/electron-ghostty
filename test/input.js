'use strict';
const assert = require('assert');
const g = require('../lib/native');
const K = require('../app/keymap.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = 40, ROWS = 6, HDR = 16;
const snap = new Uint32Array(HDR + ROWS + ROWS * COLS * 4);
const text = (r) => { let s = ''; for (let x = 0; x < COLS; x++) { const cp = snap[HDR + ROWS + (r * COLS + x) * 4]; s += cp ? String.fromCodePoint(cp) : ' '; } return s.trimEnd(); };
const flags = (r, x) => snap[HDR + ROWS + (r * COLS + x) * 4 + 3];

(async () => {
  setInterval(() => {}, 1000);
  const t = g.create(COLS, ROWS, 1 << 20, 1000);
  // ---- selection on direct VT input (no pty)
  g.write(t, Buffer.from('hello world foo\r\nsecond line here'));
  assert.strictEqual(g.select(t, 1, 7, 0, 0, 0), true, 'select word');
  assert.strictEqual(g.selectionText(t), 'world');
  g.snapshot(t, snap);
  assert.ok(flags(0, 6) & (1 << 27), 'selected flag on cell');
  assert.ok(!(flags(0, 0) & (1 << 27)), 'not selected outside');
  assert.strictEqual(g.select(t, 2, 3, 1, 0, 0), true, 'select line');
  assert.strictEqual(g.selectionText(t), 'second line here');
  assert.strictEqual(g.select(t, 0, 0, 0, 4, 0), true, 'drag select');
  assert.strictEqual(g.selectionText(t), 'hello');
  g.select(t, 4, 0, 0, 0, 0);
  assert.strictEqual(g.selectionText(t), null, 'cleared');
  // ---- theme
  const pal = new Uint32Array(256).fill(0x112233); pal[1] = 0xff0000;
  g.setTheme(t, 0xdddddd, 0x101020, 0xffffff, pal);
  g.snapshot(t, snap);
  g.snapshot(t, snap);
  console.log('theme bg', snap[6].toString(16), 'fg', snap[7].toString(16));
  assert.strictEqual(snap[6], 0x101020); assert.strictEqual(snap[7], 0xdddddd);
  g.close(t);

  // ---- key encoding through a real PTY: `cat -v` shows what the app received
  const t2 = g.create(COLS, ROWS, 1 << 20, 1000);
  g.spawn(t2, '/bin/cat', ['-v'], null, () => {});
  await sleep(200);
  const key = (code, mods, utf8, unshifted) => g.key(t2, K[code], mods, 1, utf8, unshifted || 0, false);
  assert.ok(key('KeyA', 0, 'a', 97) > 0);
  assert.ok(key('ArrowUp', 0, null) > 0);                 // normal mode: ESC [ A
  assert.ok(key('F5', 0, null) > 0);
  assert.ok(key('Enter', 0, null) > 0);                   // cat gets the line now (canonical mode)
  await sleep(300);
  assert.ok(key('KeyC', 2, 'c', 99) > 0);                 // ctrl+c -> 0x03 -> SIGINT kills cat
  await sleep(300);
  g.snapshot(t2, snap);
  const rows = [0, 1, 2].map(text);
  console.log('cat -v screen:', JSON.stringify(rows));
  assert.ok(rows.some((r) => r.includes('a^[[A^[[15~')), 'cat received a ESC[A ESC[15~');
  assert.ok(rows.some((r) => r.includes('^C')), 'ctrl+c delivered');
  g.close(t2);
  console.log('OK');
  process.exit(0);
})();
