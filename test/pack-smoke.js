'use strict';
// Run against an installed tarball: node test/pack-smoke.js <path to installed electron-ghostty>
// Loads the shipped prebuild and checks that bytes written to a terminal appear in its snapshot.
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const g = require(path.join(root, 'lib', 'native.js'));
const HDR = 16, cols = 40, rows = 5;
const t = g.create(cols, rows, 1 << 20, 100);
g.attach(t, () => {});
g.write(t, Buffer.from('hello\r\n\x1b[31mred\x1b[0m'));
const snap = new Uint32Array(HDR + rows + rows * cols * 4);
const level = g.snapshot(t, snap);
const text = (y) => Array.from({ length: 5 }, (_, x) => String.fromCodePoint(snap[HDR + rows + (y * cols + x) * 4] || 32)).join('');
if (!level || text(0) !== 'hello' || text(1).trim() !== 'red') { console.error('FAIL', level, JSON.stringify(text(0)), JSON.stringify(text(1))); process.exit(1); }
g.close(t);
console.log(`pack smoke ok (${process.platform}-${process.arch})`);
process.exit(0);
