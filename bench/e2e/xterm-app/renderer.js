'use strict';
const term = new Terminal({ cols: 118, rows: 40, scrollback: 100000, fontFamily: 'Menlo', fontSize: 14, allowProposedApi: true });
term.open(document.getElementById('t'));
term.loadAddon(new WebglAddon.WebglAddon());
window.api.onData((d) => term.write(d));
term.onData((d) => window.api.write(d));
// The benchmark types via the same path as a user: xterm's input -> pty.
window.__isDone = () => {
  const b = term.buffer.active;
  for (let i = b.length - 1; i >= Math.max(0, b.length - 60); i--) { const l = b.getLine(i); if (l && l.translateToString(true).trim() === '__DONE__') return true; }
  return false;
};
term.focus();

// key->pixel latency probe: pty echo of one character until xterm's renderer has drawn a frame containing it
window.__latency = async (n) => {
  const out = [];
  const has = (ch) => { const b = term.buffer.active; const l = b.getLine(b.baseY + b.cursorY); return !!l && l.translateToString(true).includes(ch); };
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 120));
    const ch = 'xyzqwjk'[i % 7];
    const t0 = performance.now();
    window.api.write(ch);
    await new Promise((res) => { const d = term.onRender(() => { if (has(ch)) { d.dispose(); res(); } }); });
    out.push(performance.now() - t0);
    window.api.write('\x7f');
  }
  return out;
};
