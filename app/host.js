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
  sendImages(id, p);
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

// Kitty graphics: placements go out whenever the list changes; pixels only when an image is new or changed.
function sendImages(id, p) {
  const r = g.images(p.term, p.imgGen);
  if (!r) return;
  p.imgGen = r.gen;
  const l = r.list, live = new Set();
  for (let i = 0; i < l.length; i += 14) {
    const iid = l[i], igen = l[i + 1];
    live.add(iid);
    if (p.sentImg.get(iid) !== igen) {
      const d = g.imageData(p.term, iid);
      if (!d) { live.delete(iid); continue; }
      p.sentImg.set(iid, igen);
      port.postMessage({ t: 'image', id, imageId: iid, w: d.w, h: d.h, buf: d.rgba });
    }
  }
  for (const k of [...p.sentImg.keys()]) if (!live.has(k)) p.sentImg.delete(k);
  port.postMessage({ t: 'placements', id, list: l.buffer.slice(l.byteOffset, l.byteOffset + l.byteLength) });
}

function themeFrom(extra) {
  const th = theme();
  if (!extra) return th;
  const num = (v) => (typeof v === 'number' ? v >>> 0 & 0xffffff : undefined);
  const out = { ...th };
  for (const k of ['fg', 'bg', 'cursor']) if (num(extra[k]) !== undefined) out[k] = num(extra[k]);
  if (Array.isArray(extra.ansi)) { const pal = new Uint32Array(th.pal); extra.ansi.slice(0, 16).forEach((c, i) => { if (num(c) !== undefined) pal[i] = num(c); }); out.pal = pal; }
  return out;
}

// mode 'pty' (default): the host owns the shell + PTY, bytes never reach JS. mode 'external': xterm.js-style, the page
// feeds bytes with write() and receives the child-bound bytes (keys, query replies) as 'data' messages.
function open(id, msg) {
  if (panes.has(id)) return;
  const p = { term: null, cols: msg.cols, rows: msg.rows, snap: null, wanted: false, anchor: null, cell: { w: 9, h: 18, sw: 0, sh: 0 }, imgGen: 0, sentImg: new Map(), mode: msg.mode === 'external' ? 'external' : 'pty' };
  panes.set(id, p);
  allocSnap(p);
  const th = themeFrom(msg.theme);
  const lines = Math.min(Math.max(+msg.scrollbackLines || 0, 0), 10000000);
  p.term = g.create(p.cols, p.rows, config.scrollbackBytes || Number.MAX_SAFE_INTEGER,
    lines || config.scrollbackLines || +process.env.GHOSTTY_SCROLLBACK_LINES || 100000);
  g.setTheme(p.term, th.fg, th.bg, th.cursor, th.pal);
  g.setClipboardPolicy(p.term, config.osc52 === 'allow' ? 1 : 0);
  const onEvent = (kind, status, extra) => {
    if (kind === 0) trySend(id);
    else if (kind === 1) port.postMessage({ t: 'exit', id, status });
    else if (kind === 2) port.postMessage({ t: 'clipboard-write', id, text: extra });   // OSC 52 (only when config.osc52 === 'allow')
    else if (kind === 3) port.postMessage({ t: 'data', id, buf: extra });                // external mode: bytes for the child
    else if (kind === 4) port.postMessage({ t: 'bell', id });
    else if (kind === 5) port.postMessage({ t: 'title', id, title: extra });
  };
  // The command to run comes from the embedder's config only: the page may not choose what to execute.
  if (p.mode === 'external') g.attach(p.term, onEvent);
  else g.spawn(p.term, config.shell || process.env.SHELL || '/bin/zsh', config.args || ['-l'], config.cwd || process.env.HOME, onEvent);
}

function selectionChanged(id, p) {
  const text = g.selectionText(p.term) || '';
  port.postMessage({ t: 'selection', id, text: text.length <= 1048576 ? text : text.slice(0, 1048576), truncated: text.length > 1048576 });
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
  } else if (m.action === 1) { p.anchor = null; selectionChanged(id, p); }   // release
  if (m.action === 0 && m.detail >= 2) selectionChanged(id, p);
  trySend(id);
}

function handle(data) {
  if (!data) return;                       // e.g. a message the port could not deserialize (transferred ArrayBuffer)
  const id = data.id || 1;
  if (data.t === 'open') return open(id, data);
  const p = panes.get(id);
  if (!p || !p.term) return;
  const term = p.term;
  switch (data.t) {
    case 'close': g.close(term); panes.delete(id); break;
    case 'key': g.key(term, data.code, data.mods, data.action, data.utf8, data.unshifted, !!data.composing); break;
    case 'metrics': {
      const changed = p.cell.w !== data.cw || p.cell.h !== data.ch;
      p.cell = { w: data.cw, h: data.ch, sw: data.sw, sh: data.sh };
      if (changed) { g.resize(term, p.cols, p.rows, data.cw, data.ch); p.wanted = true; trySend(id); }   // cell pixel size drives Kitty image geometry
      break;
    }
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
    case 'selectAll': g.select(term, 3, 0, 0, 0, 0); selectionChanged(id, p); trySend(id); break;
    case 'selectRange': g.select(term, 0, data.x1, data.y1, data.x2, data.y2); selectionChanged(id, p); trySend(id); break;
    case 'clearSelection': g.select(term, 4, 0, 0, 0, 0); selectionChanged(id, p); trySend(id); break;
    case 'write': {                                                                 // external mode: VT bytes from the page
      g.write(term, Buffer.from(data.buf));
      if (data.ack && data.ack.length) port.postMessage({ t: 'ack', id, acks: data.ack });
      break;
    }
    case 'scrollLines': g.scroll(term, data.delta | 0); trySend(id); break;
    case 'theme': { const th = themeFrom(data.theme); g.setTheme(term, th.fg, th.bg, th.cursor, th.pal); p.wanted = true; trySend(id); break; }
    case 'link': {                                                                // Cmd+click on an OSC 8 hyperlink
      const uri = g.hyperlinkAt(term, data.x, data.y);
      if (uri) port.postMessage({ t: 'open-link', id, uri });
      break;
    }
    case 'resize':
      p.cols = data.cols; p.rows = data.rows; allocSnap(p); g.resize(term, p.cols, p.rows, p.cell.w, p.cell.h); p.wanted = true; trySend(id); break;
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
