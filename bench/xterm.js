'use strict';
const { Terminal } = require('@xterm/headless');
const { footprint } = require('./footprint');
const { realLines, coloredLines, plainLines, chunks, mb } = require('./payload');

const COLS = 200, ROWS = 50;
const write = (t, b) => new Promise((res) => t.write(b, res));

async function throughput(name, buf) {
  const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  const cs = chunks(buf);
  const t0 = process.hrtime.bigint();
  for (const c of cs) await write(t, c);
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(`throughput ${name}: ${(buf.length / 1048576 / dt).toFixed(1)} MB/s (${mb(buf.length)} MB in ${dt.toFixed(2)}s)`);
  t.dispose();
}

async function memory(scrollLines) {
  // Payload is built BEFORE the baseline so generator garbage is not billed to the engine.
  const REAL = process.env.CORPUS === 'real';
  const block = chunks(REAL ? realLines(scrollLines + ROWS) : coloredLines(10000, COLS, 7));
  global.gc(); await new Promise((r) => setTimeout(r, 100)); global.gc();
  const base = footprint();
  const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: scrollLines, allowProposedApi: true });
  // Stream 10k-line blocks so the payload itself never dominates memory.
  for (let n = 0; n < (REAL ? 1 : scrollLines + ROWS); n += 10000) for (const c of block) await write(t, c);
  global.gc(); await new Promise((r) => setTimeout(r, 50)); global.gc();
  const rss = footprint();
  console.log(`memory scrollback=${scrollLines} lines x ${COLS} cols: +${mb(rss - base)} MB footprint (buffer lines=${t.buffer.active.length})`);
  t.dispose();
}

(async () => {
  const [, , mode, arg] = process.argv;
  if (mode === 'mem') return memory(+arg);
  if (mode === 'tp') {
    console.log('engine: @xterm/headless', require('@xterm/headless/package.json').version);
    await throughput('plain', plainLines(300000, COLS));
    return throughput('colored', coloredLines(300000, COLS));
  }
  // Orchestrator: every scenario runs in a fresh process.
  const { execFileSync } = require('child_process');
  const run = (...a) => process.stdout.write(execFileSync(process.execPath,
    ['--expose-gc', '--max-old-space-size=12288', __filename, ...a], { encoding: 'utf8' }));
  run('tp');
  for (const n of [10000, 100000, 1000000]) run('mem', String(n));
})();
