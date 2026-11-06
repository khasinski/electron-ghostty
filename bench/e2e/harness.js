'use strict';
// Shared end-to-end benchmark driver for both Electron apps (xterm.js baseline and electron-ghostty).
const { execFileSync } = require('child_process');
const path = require('path');
const CORPUS = path.join(__dirname, 'corpus.txt');
const CORPUS_MB = require('fs').statSync(CORPUS).size / 1048576;

function footprintMB(pid) {
  try {
    const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' });
    const m = out.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB|B)/);
    return m ? parseFloat(m[1]) * { B: 1, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] / (m[2] === 'B' ? 1048576 : 1) : 0;
  } catch { return 0; }
}
function treeFootprint(app) {
  const parts = {}; let total = 0;
  for (const p of app.getAppMetrics()) {
    const mb = footprintMB(p.pid);
    parts[`${p.type}${p.serviceName ? ':' + p.serviceName : ''}#${p.pid}`] = +mb.toFixed(1);
    total += mb;
  }
  return { total: +total.toFixed(1), parts };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// send(str): types into the terminal. isDoneExpr: JS evaluated in the renderer, true when the marker is on screen.
async function run(app, win, { label, send, isDoneExpr }) {
  await sleep(2500);
  const idleEarly = treeFootprint(app);
  await sleep(5000);
  const idle = treeFootprint(app);
  const cmd = `cat ${CORPUS}; echo __DO''NE__\r`;
  const t0 = process.hrtime.bigint();
  await send(cmd);
  let done = false;
  while (Number(process.hrtime.bigint() - t0) / 1e9 < 180) {
    if (await win.webContents.executeJavaScript(isDoneExpr)) { done = true; break; }
    await sleep(10);
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const afterFlood = treeFootprint(app);
  await sleep(6000);                                   // let idle compression / GC settle
  const settled = treeFootprint(app);
  console.log('RESULT ' + JSON.stringify({
    label, done, corpusMB: +CORPUS_MB.toFixed(1), seconds: +secs.toFixed(2), MBps: +(CORPUS_MB / secs).toFixed(1),
    idleEarlyMB: idleEarly.total, idleMB: idle.total, idleParts: idle.parts, afterFloodMB: afterFlood.total, settledMB: settled.total, settledParts: settled.parts,
  }));
  app.quit();
}
module.exports = { run };
