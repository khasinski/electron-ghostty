'use strict';
const g = require('../build/Release/ghostty_native.node');
const { footprint } = require('./footprint');
const { realLines, coloredLines, plainLines, chunks, mb } = require('./payload');

const COLS = 200, ROWS = 50;
// Scrollback is capped in BYTES in libghostty. Effectively unlimited for the memory test,
// so the line count (not the cap) decides what is retained.
const UNLIMITED = Number.MAX_SAFE_INTEGER;

function throughput(name, buf) {
  const t = g.create(COLS, ROWS, 1000 * COLS * 16);
  const cs = chunks(buf);
  const t0 = process.hrtime.bigint();
  for (const c of cs) g.write(t, c);
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(`throughput ${name}: ${(buf.length / 1048576 / dt).toFixed(1)} MB/s (${mb(buf.length)} MB in ${dt.toFixed(2)}s)`);
}

function memory(scrollLines, compress) {
  const REAL = process.env.CORPUS === 'real';
  const block = chunks(REAL ? realLines(scrollLines + ROWS) : coloredLines(10000, COLS, 7));
  global.gc(); global.gc();
  const base = footprint();
  const t = g.create(COLS, ROWS, UNLIMITED);
  for (let n = 0; n < (REAL ? 1 : scrollLines + ROWS); n += 10000) for (const c of block) g.write(t, c);
  global.gc();
  const before = footprint();
  let note = '';
  if (compress) {
    while (g.compress(t, false) === 1);
    note = ` -> after compression +${mb(footprint() - base)} MB`;
  }
  const m = g.memory(t);
  console.log(`memory scrollback=${scrollLines} lines x ${COLS} cols: +${mb(before - base)} MB footprint` +
    ` (libghostty resident ${mb(m.resident)} MB, pages ${m.pages}, compressed ${m.compressedPages})${note}`);
}

function online(scrollLines, drainEvery) {
  // Flood real text; every `drainEvery` chunks run incremental compression until it reports
  // complete (0 = never during the flood). Timing excludes the footprint samples.
  const buf = realLines(scrollLines + ROWS);
  const cs = chunks(buf);
  global.gc(); global.gc();
  const base = footprint();
  const t = g.create(COLS, ROWS, UNLIMITED);
  let peak = 0, steps = 0, spent = 0n, sampling = 0n;
  for (let i = 0; i < cs.length; i++) {
    const t0 = process.hrtime.bigint();
    g.write(t, cs[i]);
    if (drainEvery) { const m = g.memory(t); if (m.pages - m.compressedPages > drainEvery) { while (g.compress(t, false) === 1) steps++; } }
    spent += process.hrtime.bigint() - t0;
    if (i % 25 === 0) peak = Math.max(peak, footprint() - base);
  }
  const dt = Number(spent) / 1e9;
  const t1 = process.hrtime.bigint();
  while (g.compress(t, false) === 1) steps++;
  const end = footprint() - base;
  const m = g.memory(t);
  console.log(`compress when >${drainEvery || 'never'} hot pages, ${scrollLines} lines: ${(buf.length / 1048576 / dt).toFixed(0)} MB/s, ` +
    `peak +${mb(peak)} MB, final +${mb(end)} MB (resident ${mb(m.resident)}, steps ${steps}, tail-drain ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(0)} ms)`);
}

(async () => {
  const [, , mode, arg, arg2] = process.argv;
  if (mode === 'online') return online(+arg, +arg2);
  if (mode === 'mem') return memory(+arg, arg2 === 'c');
  if (mode === 'tp') {
    console.log('engine: libghostty-vt via N-API addon');
    throughput('plain', plainLines(300000, COLS));
    return throughput('colored', coloredLines(300000, COLS));
  }
  const { execFileSync } = require('child_process');
  const run = (...a) => process.stdout.write(execFileSync(process.execPath,
    ['--expose-gc', __filename, ...a], { encoding: 'utf8' }));
  run('tp');
  for (const n of [10000, 100000, 1000000]) { run('mem', String(n)); run('mem', String(n), 'c'); }
})();
