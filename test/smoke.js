'use strict';
const assert = require('assert');
const g = require('../build/Release/ghostty_native.node');
const COLS = 40, ROWS = 6, HDR = 16;

const words = HDR + ROWS + ROWS * COLS * 4;
const sab = new SharedArrayBuffer(words * 4);   // renderer will read the same memory
const snap = new Uint32Array(sab);

const t = g.create(COLS, ROWS, 1 << 20);
let exited = null;
g.spawn(t, '/bin/sh', ['-c', `printf 'hello \\033[1;31mred\\033[0m \\033[48;2;0;0;255mblue\\033[0m\\r\\n\\344\\275\\240\\r\\nline3'; printf '\\033[6n'; sleep 0.3`], null,
  (kind, status) => { if (kind === 1) exited = status; });

const text = (row) => { let s = ''; for (let x = 0; x < COLS; x++) { const cp = snap[HDR + ROWS + (row * COLS + x) * 4]; s += cp ? String.fromCodePoint(cp) : ' '; } return s.trimEnd(); };
const cell = (row, x) => { const o = HDR + ROWS + (row * COLS + x) * 4; return { cp: snap[o], fg: snap[o + 1], bg: snap[o + 2], flags: snap[o + 3] }; };

setTimeout(() => {
  const level = g.snapshot(t, snap);
  console.log('dirty level', level, 'version', snap[0], 'size', snap[1], 'x', snap[2], 'cursor', snap[3], snap[4]);
  for (let r = 0; r < 4; r++) console.log(r, JSON.stringify(text(r)));
  assert.strictEqual(level, 2);
  assert.strictEqual(text(0), 'hello red blue');
  const red = cell(0, 6);
  assert.strictEqual(red.cp, 'r'.codePointAt(0));
  assert.ok(red.flags & 1, 'bold');
  assert.ok(red.flags & (1 << 24), 'fg explicit');
  assert.ok((red.fg >> 16) > 0x80, 'reddish fg: ' + red.fg.toString(16));
  const blue = cell(0, 11);
  assert.strictEqual(blue.bg, 0x0000ff);
  assert.strictEqual(cell(1, 0).cp, 0x4f60, 'CJK char');
  assert.strictEqual((cell(1, 0).flags >> 16) & 3, 1, 'wide');
  // The terminal answered ESC[6n (DSR) through the PTY; the tty echoes that reply (cursor at row 3, col 6).
  assert.strictEqual(text(2), 'line3^[[3;6R');
  // Second snapshot without new output: clean.
  assert.strictEqual(g.snapshot(t, snap), 0);
  console.log('memory', g.memory(t));
  setTimeout(() => { console.log('exit status', exited); assert.strictEqual(exited, 0); g.close(t); console.log('OK'); }, 600);
}, 250);
