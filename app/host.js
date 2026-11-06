'use strict';
// Utility process: owns every terminal (libghostty + PTY) of a window and streams dirty rows to the
// renderer on demand, per pane. One process for all panes: no per-terminal process overhead.
const path = require('path');
const g = require(path.join(__dirname, '..', 'build', 'Release', 'ghostty_native.node'));
const HDR = 16;

let config = {};
let port = null;
const panes = new Map();                 // id -> { term, cols, rows, snap, wanted, anchor, cell }

// Catppuccin Mocha. 16 ANSI colors + the standard xterm 6x6x6 cube and gray ramp for 16..255.
function theme() {
  const ansi = [0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xbac2de,
                0x585b70, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xa6adc8];
  const pal = new Uint32Array(256);
  ansi.forEach((c, i) => { pal[i] = c; });
  const lv = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) pal[16 + i] = (lv[(i / 36) | 0] << 16) | (lv[((i / 6) | 0) % 6] << 8) | lv[i % 6];
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; pal[232 + i] = (v << 16) | (v << 8) | v; }
  return { fg: 0xcdd6f4, bg: 0x1e1e2e, cursor: 0xf5e0dc, pal, ...(config.theme || {}) };
}

function allocSnap(p) { p.snap = new Uint32Array(HDR + p.rows + p.rows * p.cols * 4); }

function trySend(id) {
  const p = panes.get(id);
  if (!p || !p.term || !p.wanted) return;
  const { cols, rows, snap } = p;
  const level = g.snapshot(p.term, snap);
  if (level === 0) return;                       // nothing new: keep the request pending
  let n = 0;
  for (let y = 0; y < rows; y++) if (snap[HDR + y]) n++;
  const stride = 1 + cols * 4;
  const out = new Uint32Array(HDR + n * stride);
  out.set(snap.subarray(0, HDR), 0);
  out[12] = n;
  let o = HDR;
  const cellsBase = HDR + rows;
  for (let y = 0; y < rows; y++) {
    if (!snap[HDR + y]) continue;
    out[o++] = y;
    out.set(snap.subarray(cellsBase + y * cols * 4, cellsBase + (y + 1) * cols * 4), o);
    o += cols * 4;
  }
  p.wanted = false;
  port.postMessage({ t: 'frame', id, buf: out.buffer });  // MessagePortMain can only transfer ports: buffer is copied (a few KB)
}

function open(id, msg) {
  if (panes.has(id)) return;
  const p = { term: null, cols: msg.cols, rows: msg.rows, snap: null, wanted: false, anchor: null, cell: { w: 9, h: 18, sw: 0, sh: 0 } };
  panes.set(id, p);
  allocSnap(p);
  const th = theme();
  p.term = g.create(p.cols, p.rows, config.scrollbackBytes || Number.MAX_SAFE_INTEGER,
    config.scrollbackLines || +process.env.GHOSTTY_SCROLLBACK_LINES || 100000);
  g.setTheme(p.term, th.fg, th.bg, th.cursor, th.pal);
  g.setClipboardPolicy(p.term, config.osc52 === 'allow' ? 1 : 0);
  g.spawn(p.term, config.shell || process.env.SHELL || '/bin/zsh', config.args || ['-l'], config.cwd || process.env.HOME,
    (kind, status, extra) => {
      if (kind === 0) trySend(id);
      else if (kind === 1) port.postMessage({ t: 'exit', id, status });
      else if (kind === 2) port.postMessage({ t: 'clipboard-write', id, text: extra });   // OSC 52 (only when config.osc52 === 'allow')
    });
}

// Mouse: if the program enabled mouse tracking it owns the mouse (unless Shift is held); otherwise we select text.
function mouse(id, p, m) {
  const c = p.cell;
  const consumed = !(m.mods & 1) && g.mouse(p.term, m.action, m.button, m.mods, m.px, m.py, c.sw, c.sh, c.w, c.h, !!m.pressed);
  if (consumed) { p.anchor = null; return; }
  if (m.button !== 1 && m.action !== 2) return;
  if (m.action === 0) {                                   // press
    if (m.detail >= 3) g.select(p.term, 2, m.x, m.y, 0, 0);
    else if (m.detail === 2) g.select(p.term, 1, m.x, m.y, 0, 0);
    else { g.select(p.term, 4, 0, 0, 0, 0); p.anchor = { x: m.x, y: m.y }; }
  } else if (m.action === 2 && p.anchor && m.pressed) {  // drag
    g.select(p.term, 0, p.anchor.x, p.anchor.y, m.x, m.y);
  } else if (m.action === 1) p.anchor = null;             // release
  trySend(id);
}

function handle(data) {
  const id = data.id || 1;
  if (data.t === 'open') return open(id, data);
  const p = panes.get(id);
  if (!p || !p.term) return;
  const term = p.term;
  switch (data.t) {
    case 'close': g.close(term); panes.delete(id); break;
    case 'key': g.key(term, data.code, data.mods, data.action, data.utf8, data.unshifted, !!data.composing); break;
    case 'metrics': p.cell = { w: data.cw, h: data.ch, sw: data.sw, sh: data.sh }; break;
    case 'mouse': mouse(id, p, data); break;
    case 'text': g.input(term, Buffer.from(data.text, 'utf8')); break;           // IME / synthetic typing, no encoding
    case 'paste': if (g.paste(term, data.text) === 1) port.postMessage({ t: 'paste-rejected', id }); break;
    case 'wheel': {
      const c = p.cell;
      const consumed = !(data.mods & 1) && g.mouse(term, 0, data.delta < 0 ? 4 : 5, data.mods, data.px, data.py, c.sw, c.sh, c.w, c.h, false);
      if (!consumed) { g.scroll(term, data.delta); trySend(id); }
      break;
    }
    case 'copy': port.postMessage({ t: 'clipboard', id, text: g.selectionText(term) }); break;
    case 'selectAll': g.select(term, 3, 0, 0, 0, 0); trySend(id); break;
    case 'link': {                                                                // Cmd+click on an OSC 8 hyperlink
      const uri = g.hyperlinkAt(term, data.x, data.y);
      if (uri) port.postMessage({ t: 'open-link', id, uri });
      break;
    }
    case 'resize':
      p.cols = data.cols; p.rows = data.rows; allocSnap(p); g.resize(term, p.cols, p.rows); p.wanted = true; trySend(id); break;
    case 'want': p.wanted = true; trySend(id); break;
    case 'stats': port.postMessage({ t: 'stats', panes: panes.size, mem: g.memory(term), rss: process.memoryUsage().rss }); break;
  }
}

process.parentPort.once('message', (e) => {
  port = e.ports[0];
  config = (e.data && e.data.config) || {};
  port.on('message', ({ data }) => handle(data));
  port.start();
});
