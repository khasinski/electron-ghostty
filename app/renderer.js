'use strict';
// WebGL2 terminal renderer. One full-screen triangle; the grid lives in an RGBA32UI texture
// (one texel per cell: glyph slot, fg, bg, decorations) and glyphs come from a bounded R8 atlas.
// The shader does everything per pixel, so a frame is a single draw call regardless of grid size.

const HDR = 16;
const FONT_FAMILY = 'Menlo, "SF Mono", Monaco, monospace';
const FONT_CSS_PX = 14;
const SELECTION_BG = 0x45475a;
const ATLAS_SIZE = 2048; // R8 => 4 MB, hard cap (LRU-less reset when full)

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, desynchronized: true, powerPreference: 'high-performance' });
if (!gl) throw new Error('WebGL2 unavailable');

// ---------- metrics & glyph atlas ----------
let dpr = 1, cellW = 9, cellH = 18, baseline = 14, fontPx = 14;
const gctx = new OffscreenCanvas(8, 8).getContext('2d', { willReadFrequently: true });
let slotsPerRow = 1, slotRows = 1, nextSlot = 1;
const glyphSlots = new Map(); // key -> slot (wide glyphs take slot and slot+1)

function fontFor(bold, italic) { return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontPx}px ${FONT_FAMILY}`; }

function measure() {
  dpr = window.devicePixelRatio || 1;
  fontPx = Math.round(FONT_CSS_PX * dpr);
  gctx.font = fontFor(false, false);
  const m = gctx.measureText('M');
  cellW = Math.max(1, Math.round(m.width));
  const asc = m.fontBoundingBoxAscent ?? fontPx * 0.8, desc = m.fontBoundingBoxDescent ?? fontPx * 0.25;
  cellH = Math.ceil(asc + desc);
  baseline = Math.round(asc);
  gctx.canvas.width = cellW * 2; gctx.canvas.height = cellH;
  slotsPerRow = Math.floor(ATLAS_SIZE / cellW); slotRows = Math.floor(ATLAS_SIZE / cellH);
}

const atlasTex = gl.createTexture();
// Color glyphs (emoji) live in a separate RGBA atlas that is only allocated when the first one is drawn.
const COLOR_FLAG = 0x80000000;
const COLOR_ATLAS = 1024;                  // RGBA8 => 4 MB, only paid when emoji actually appear
let colorTex = null, nextSlotC = 1, slotsPerRowC = 1, slotRowsC = 1;
function resetAtlas() {
  glyphSlots.clear(); nextSlot = 1; nextSlotC = 1;
  if (colorTex) { gl.deleteTexture(colorTex); colorTex = null; }   // give the 4 MB back; re-created on demand
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
}

let atlasFull = false;
const px8 = () => new Uint8Array(cellW * cellH);

function uploadSlot(slot, data) {
  const sx = (slot % slotsPerRow) * cellW, sy = Math.floor(slot / slotsPerRow) * cellH;
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, cellW, cellH, gl.RED, gl.UNSIGNED_BYTE, data);
}

// Returns the slot of (cp, style); wide glyphs get two consecutive slots (left half, right half).
// Color glyphs (emoji) come back flagged with COLOR_FLAG and live in the RGBA atlas.
function glyphSlot(cp, bold, italic, wide) {
  const key = cp * 4 + (bold ? 1 : 0) + (italic ? 2 : 0);
  let s = glyphSlots.get(key);
  if (s !== undefined) return s;
  const need = wide ? 2 : 1;
  gctx.clearRect(0, 0, cellW * 2, cellH);
  gctx.font = fontFor(bold, italic);
  gctx.fillStyle = '#fff';
  gctx.textBaseline = 'alphabetic';
  gctx.fillText(String.fromCodePoint(cp), 0, baseline);
  const img = gctx.getImageData(0, 0, cellW * 2, cellH).data;
  // A glyph is "color" if any visible pixel is not gray/white (monochrome text is drawn in white).
  let isColor = false;
  for (let i = 0; i < img.length; i += 4) if (img[i + 3] > 16 && (img[i] !== img[i + 1] || img[i + 1] !== img[i + 2])) { isColor = true; break; }
  if (isColor) {
    if (!colorTex) {
      colorTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, COLOR_ATLAS, COLOR_ATLAS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      slotsPerRowC = Math.floor(COLOR_ATLAS / cellW); slotRowsC = Math.floor(COLOR_ATLAS / cellH);
    }
    if (nextSlotC + need > slotsPerRowC * slotRowsC) { atlasFull = true; return 0; }
    s = nextSlotC; nextSlotC += need;
    for (let half = 0; half < need; half++) {
      const out = new Uint8Array(cellW * cellH * 4);
      for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) {
        const si = (y * cellW * 2 + half * cellW + x) * 4, di = (y * cellW + x) * 4;
        out[di] = img[si]; out[di + 1] = img[si + 1]; out[di + 2] = img[si + 2]; out[di + 3] = img[si + 3];
      }
      const slot = s + half, sx = (slot % slotsPerRowC) * cellW, sy = Math.floor(slot / slotsPerRowC) * cellH;
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, sx, sy, cellW, cellH, gl.RGBA, gl.UNSIGNED_BYTE, out);
    }
    s = (s | COLOR_FLAG) >>> 0;
  } else {
    if (nextSlot + need > slotsPerRow * slotRows) { atlasFull = true; return 0; }
    s = nextSlot; nextSlot += need;
    for (let half = 0; half < need; half++) {
      const out = px8();
      for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) out[y * cellW + x] = img[(y * cellW * 2 + half * cellW + x) * 4 + 3];
      uploadSlot(s + half, out);
    }
  }
  glyphSlots.set(key, s);
  return s;
}

// ---------- GL program ----------
const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uCells; uniform sampler2D uAtlas, uColorAtlas;
uniform ivec2 uCell, uGrid, uSlots, uSlotsC, uView, uOrigin;
uniform vec3 uDefBg, uCursorColor;
uniform ivec3 uCursor; // x, y, style (-1 = hidden)
out vec4 o;
vec3 unpack(uint c){ return vec3(float((c>>16)&255u), float((c>>8)&255u), float(c&255u))/255.0; }
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy) - uOrigin; px.y = uView.y - 1 - px.y;   // pane-local, top-left origin
  ivec2 cell = px / uCell;
  if (cell.x >= uGrid.x || cell.y >= uGrid.y) { o = vec4(uDefBg, 1.0); return; }
  uvec4 t = texelFetch(uCells, cell, 0);
  ivec2 lp = px - cell * uCell;
  vec3 fg = unpack(t.g), bg = unpack(t.b);
  float cov = 0.0;
  vec4 color = vec4(0.0);                       // color glyph (emoji): premultiplied into the cell below
  if (t.r != 0u) {
    if ((t.r & 0x80000000u) != 0u) { int s = int(t.r & 0x7fffffffu); color = texelFetch(uColorAtlas, ivec2(s % uSlotsC.x, s / uSlotsC.x) * uCell + lp, 0); }
    else { int s = int(t.r); cov = texelFetch(uAtlas, ivec2(s % uSlots.x, s / uSlots.x) * uCell + lp, 0).r; }
  }
  int thick = max(1, uCell.y / 16);
  uint ul = t.a & 7u;
  if (ul != 0u) {
    int y0 = uCell.y - 1 - thick;
    bool on = lp.y >= y0 && lp.y < y0 + thick;
    if (ul == 2u) on = on || (lp.y >= y0 - 2*thick && lp.y < y0 - thick);
    if (ul == 3u) on = (lp.y >= y0 - thick + int(1.5 * sin(float(lp.x) * 6.2831 / float(max(uCell.x,2))) + 1.5)) && (lp.y < y0 + thick + int(1.5 * sin(float(lp.x) * 6.2831 / float(max(uCell.x,2))) + 1.5)) && lp.y >= y0 - 1;
    if (ul == 4u) on = on && ((lp.x / max(thick,1)) % 2 == 0);
    if (ul == 5u) on = on && ((lp.x / max(2*thick,1)) % 3 != 2);
    if (on) cov = 1.0;
  }
  if ((t.a & 8u) != 0u) { int ys = uCell.y / 2; if (lp.y >= ys && lp.y < ys + thick) cov = 1.0; }
  if ((t.a & 16u) != 0u) { if (lp.y < thick) cov = 1.0; }
  vec3 c = mix(mix(bg, fg, cov), color.rgb, color.a);
  if (uCursor.z >= 0 && cell == uCursor.xy) {
    if (uCursor.z == 1) { c = mix(uCursorColor, bg, cov); }                       // block: invert glyph on cursor color
    else if (uCursor.z == 0) { if (lp.x < thick) c = uCursorColor; }               // bar
    else if (uCursor.z == 2) { if (lp.y >= uCell.y - thick) c = uCursorColor; }    // underline
    else { if (lp.x < thick || lp.y < thick || lp.x >= uCell.x - thick || lp.y >= uCell.y - thick) c = uCursorColor; } // hollow
  }
  o = vec4(c, 1.0);
}`;

function compile(type, src) {
  const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const U = {};
for (const n of ['uCells', 'uAtlas', 'uColorAtlas', 'uSlotsC', 'uCell', 'uGrid', 'uSlots', 'uView', 'uOrigin', 'uDefBg', 'uCursorColor', 'uCursor']) U[n] = gl.getUniformLocation(prog, n);
gl.bindVertexArray(gl.createVertexArray());

// ---------- panes: many terminals, one canvas, one GL context, one glyph atlas ----------
const panes = new Map();       // id -> Pane (insertion order = left-to-right)
let focused = null, nextId = 1;
const GAP = 2;                 // device px between panes
let port = null;

class Pane {
  constructor(id) {
    this.id = id; this.opened = false; this.gotFrame = false;
    this.cols = 0; this.rows = 0; this.shadow = null; this.grid = null; this.tex = gl.createTexture();
    this.defFg = 0xcdd6f4; this.defBg = 0x1e1e2e;
    this.cursor = { x: 0, y: 0, style: -1, color: 0xcdd6f4 };
    this.dirty = new Set(); this.full = true;
    this.rect = { x: 0, y: 0, w: 1, h: 1 };       // device px inside the canvas
  }
  alloc(c, r) {
    this.cols = c; this.rows = r;
    this.shadow = new Uint32Array(c * r * 4);
    this.grid = new Uint32Array(c * r * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, c, r, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.full = true;
  }
  dispose() { gl.deleteTexture(this.tex); }
}
const send = (msg) => { if (focused) port.postMessage({ ...msg, id: focused.id }); };
const sendTo = (p, msg) => port.postMessage({ ...msg, id: p.id });

function mix(a, b, t) { // a*(1-t)+b*t per channel on 0xRRGGBB
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t, g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t, bl = (a & 255) * (1 - t) + (b & 255) * t;
  return ((r | 0) << 16) | ((g | 0) << 8) | (bl | 0);
}

// Convert one row of raw cells into texels (glyph slots + resolved colors).
function processRow(p, y) {
  const { cols, shadow, grid } = p;
  const base = y * cols * 4;
  let prevKeyCp = 0, prevBold = false, prevItalic = false;
  for (let x = 0; x < cols; x++) {
    const i = base + x * 4;
    const cp = shadow[i], fgRaw = shadow[i + 1], bgRaw = shadow[i + 2], fl = shadow[i + 3];
    const wide = (fl >> 16) & 3, bold = (fl & 1) !== 0, italic = (fl & 2) !== 0;
    let fg = (fl & (1 << 24)) ? fgRaw : p.defFg, bg = (fl & (1 << 25)) ? bgRaw : p.defBg;
    if (fl & 16) { const t = fg; fg = bg; bg = t; }          // inverse
    if (fl & (1 << 27)) { bg = SELECTION_BG; fg = p.defFg; } // selected
    if (fl & 4) fg = mix(fg, bg, 0.5);                       // faint
    let slot = 0;
    if (!(fl & 32)) {                                        // invisible
      if (wide === 2) { const s = glyphSlots.get(prevKeyCp * 4 + (prevBold ? 1 : 0) + (prevItalic ? 2 : 0)); if (s) slot = (((s & 0x7fffffff) + 1) | (s & COLOR_FLAG)) >>> 0; }
      else if (wide !== 3 && cp > 32) slot = glyphSlot(cp, bold, italic, wide === 1);
    }
    prevKeyCp = cp; prevBold = bold; prevItalic = italic;
    const ul = (fl >> 8) & 7;
    grid[i] = slot; grid[i + 1] = fg; grid[i + 2] = bg;
    grid[i + 3] = ul | ((fl & 64) ? 8 : 0) | ((fl & 128) ? 16 : 0);
  }
}
function uploadRow(p, y) {
  gl.bindTexture(gl.TEXTURE_2D, p.tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, p.cols, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, p.grid, y * p.cols * 4);
}

function applyFrame(p, buf) {
  const w = new Uint32Array(buf);
  const c = w[1], r = w[2];
  if (c !== p.cols || r !== p.rows) p.alloc(c, r);
  p.defBg = w[6]; p.defFg = w[7];
  p.cursor.color = w[8] === 0xffffffff ? p.defFg : w[8];
  const flags = w[5];
  p.cursor.x = w[3]; p.cursor.y = w[4]; p.cursor.style = (flags & 1) && (flags & 2) ? (flags >> 4) & 15 : -1;
  const n = w[12];
  let o = HDR;
  for (let k = 0; k < n; k++) {
    const y = w[o++];
    p.shadow.set(w.subarray(o, o + p.cols * 4), y * p.cols * 4);
    o += p.cols * 4;
    p.dirty.add(y);
  }
  if (w[9] === 2) p.full = true;
  p.gotFrame = true;
}

// ---------- frame loop ----------
let framePending = false, drawScheduled = false, lastDrawAt = 0, probe = null;
const stats = { frames: 0, cellsUploaded: 0, lastFrameMs: 0, worstFrameMs: 0, atlasSlots: 0 };
window.__ghostty = stats;
window.sendInput = (s) => send({ t: 'text', text: s });
window.__send = (msg) => send(msg);
window.__panes = () => [...panes.values()].map((p) => ({ id: p.id, cols: p.cols, rows: p.rows, rect: p.rect, focused: p === focused }));
// Debug: grid text of a pane (ground truth for tests, independent of GL output).
window.__dump = (id) => { const p = id ? panes.get(id) : focused; const out = []; if (!p || !p.shadow) return out;
  for (let y = 0; y < p.rows; y++) { let l = ''; for (let x = 0; x < p.cols; x++) { const cp = p.shadow[(y * p.cols + x) * 4]; l += cp ? String.fromCodePoint(cp) : ' '; } out.push(l.trimEnd()); }
  while (out.length && !out[out.length - 1]) out.pop(); return out; };

const rgb = (v) => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];

function draw() {
  drawScheduled = false;
  const t0 = performance.now(); stats.tDraw = t0; lastDrawAt = t0;
  const list = [...panes.values()].filter((p) => p.grid);
  if (!list.length) return;
  for (const p of list) if (p.full) { for (let y = 0; y < p.rows; y++) p.dirty.add(y); p.full = false; }
  for (const p of list) for (const y of p.dirty) processRow(p, y);
  if (atlasFull) {                 // atlas exhausted: start over and rebuild every row of every pane (bounded memory)
    atlasFull = false; resetAtlas();
    for (const p of list) { for (let y = 0; y < p.rows; y++) p.dirty.add(y); for (const y of p.dirty) processRow(p, y); }
  }
  for (const p of list) { for (const y of p.dirty) uploadRow(p, y); stats.cellsUploaded += p.dirty.size * p.cols; p.dirty.clear(); }

  // The drawing buffer is cleared after each composite, so every pane is redrawn every frame: one draw call each.
  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.067, 0.067, 0.106, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlasTex); gl.uniform1i(U.uAtlas, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, colorTex || atlasTex); gl.uniform1i(U.uColorAtlas, 2);
  gl.uniform2i(U.uCell, cellW, cellH); gl.uniform2i(U.uSlots, slotsPerRow, slotRows); gl.uniform2i(U.uSlotsC, slotsPerRowC, slotRowsC);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(U.uCells, 0);
  for (const p of list) {
    const r = p.rect, vy = canvas.height - r.y - r.h;
    gl.viewport(r.x, vy, r.w, r.h);
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.uniform2i(U.uGrid, p.cols, p.rows); gl.uniform2i(U.uView, r.w, r.h); gl.uniform2i(U.uOrigin, r.x, vy);
    gl.uniform3f(U.uDefBg, ...rgb(p.defBg)); gl.uniform3f(U.uCursorColor, ...rgb(p.cursor.color));
    const style = p === focused ? p.cursor.style : (p.cursor.style >= 0 ? 3 : -1);   // unfocused panes show a hollow cursor
    gl.uniform3i(U.uCursor, p.cursor.x, p.cursor.y, style);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (probe) probe();
  stats.frames++; stats.atlasSlots = nextSlot;
  stats.lastFrameMs = performance.now() - t0; stats.worstFrameMs = Math.max(stats.worstFrameMs, stats.lastFrameMs);
  framePending = false;
  for (const p of list) if (p.gotFrame) { p.gotFrame = false; sendTo(p, { t: 'want' }); }   // next frame only after this one is on screen
}

// Interactive path: if the last draw was a while ago (typing, idle prompt) draw right away; WebGL commands are
// composited at the next vsync regardless, so waiting for rAF only adds latency. During floods draws are
// closer than a frame apart and fall back to rAF pacing, so we never submit more than ~60 frames/s.
function scheduleDraw() {
  if (drawScheduled) return;
  if (performance.now() - lastDrawAt > 14) { draw(); return; }
  drawScheduled = true; requestAnimationFrame(draw);
}

// ---------- layout: equal-width columns, one per pane ----------
function layout() {
  measure();
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
  resetAtlas();
  const list = [...panes.values()], n = list.length;
  if (!port || !n) return;
  const w = Math.floor((canvas.width - GAP * (n - 1)) / n);
  list.forEach((p, i) => {
    p.rect = { x: i * (w + GAP), y: 0, w, h: canvas.height };
    const c = Math.max(2, Math.floor(w / cellW)), r = Math.max(1, Math.floor(canvas.height / cellH));
    if (!p.opened) { p.opened = true; sendTo(p, { t: 'open', cols: c, rows: r }); p.alloc(c, r); sendTo(p, { t: 'want' }); }
    else if (c !== p.cols || r !== p.rows) { sendTo(p, { t: 'resize', cols: c, rows: r }); p.alloc(c, r); }
    sendTo(p, { t: 'metrics', cw: cellW, ch: cellH, sw: p.rect.w, sh: p.rect.h });
    p.full = true;
  });
  scheduleDraw();
}
new ResizeObserver(() => layout()).observe(canvas);

function newPane() { const p = new Pane(nextId++); panes.set(p.id, p); focused = p; layout(); return p; }
function closePane(p) {
  sendTo(p, { t: 'close' }); panes.delete(p.id); p.dispose();
  if (!panes.size) { window.close(); return; }
  if (focused === p) focused = [...panes.values()].pop();
  layout();
}
function focusStep(d) { const l = [...panes.values()]; focused = l[(l.indexOf(focused) + d + l.length) % l.length]; scheduleDraw(); }
function paneAt(px, py) { for (const p of panes.values()) { const r = p.rect; if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return p; } return null; }

// ---------- input ----------
// Keys go to libghostty's encoder (kitty keyboard protocol, DECCKM, modifyOtherKeys...): the renderer
// only describes the physical key + modifiers + text. A hidden textarea owns focus so the OS IME works.
const ime = document.getElementById('ime');
const MOD = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8, CAPS: 16, NUM: 32 };
const modsOf = (e) => (e.shiftKey ? MOD.SHIFT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.altKey ? MOD.ALT : 0) | (e.metaKey ? MOD.SUPER : 0) |
  (e.getModifierState && e.getModifierState('CapsLock') ? MOD.CAPS : 0) | (e.getModifierState && e.getModifierState('NumLock') ? MOD.NUM : 0);
const UNSHIFTED = (e) => /^Key[A-Z]$/.test(e.code) ? e.code.charCodeAt(3) + 32 : /^Digit\d$/.test(e.code) ? e.code.charCodeAt(5) : (e.key.length === 1 && !e.shiftKey ? e.key.codePointAt(0) : 0);

function sendKey(e, action) {
  const code = KEYMAP[e.code];
  if (code === undefined) return false;
  const text = e.key.length > 0 && [...e.key].length === 1 && !e.ctrlKey ? e.key : (e.ctrlKey && e.key.length === 1 ? e.key : null);
  send({ t: 'key', code, mods: modsOf(e), action, utf8: action === 0 ? null : text, unshifted: UNSHIFTED(e), composing: false });
  return true;
}

let composing = false;
ime.addEventListener('compositionstart', () => { composing = true; });
ime.addEventListener('compositionend', (e) => { composing = false; if (e.data) send({ t: 'text', text: e.data }); ime.value = ''; });
ime.addEventListener('keydown', (e) => {
  if (composing || e.isComposing || e.keyCode === 229) return;       // the IME owns these keys
  if (e.metaKey) {                                                    // app shortcuts
    if (e.code === 'KeyC') { send({ t: 'copy' }); e.preventDefault(); return; }
    if (e.code === 'KeyA') { send({ t: 'selectAll' }); e.preventDefault(); return; }
    if (e.code === 'KeyV') return;                                    // let the paste event fire
    if (e.code === 'KeyD') { newPane(); e.preventDefault(); return; }
    if (e.code === 'KeyW') { closePane(focused); e.preventDefault(); return; }
    if (e.code === 'BracketRight') { focusStep(1); e.preventDefault(); return; }
    if (e.code === 'BracketLeft') { focusStep(-1); e.preventDefault(); return; }
  }
  if (sendKey(e, e.repeat ? 2 : 1)) e.preventDefault();
});
ime.addEventListener('keyup', (e) => { if (!composing && !e.isComposing) sendKey(e, 0); });
ime.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData.getData('text/plain'); if (t) send({ t: 'paste', text: t }); });
ime.addEventListener('input', (e) => { if (!composing && e.data && e.inputType === 'insertText') send({ t: 'text', text: e.data }); ime.value = ''; });

// ---- mouse: coordinates in device pixels, relative to the pane under the pointer
let pressed = 0, dragPane = null;
function mouseMsg(e, action, p) {
  const r = canvas.getBoundingClientRect();
  const cx = Math.max(0, (e.clientX - r.left) * dpr), cy = Math.max(0, (e.clientY - r.top) * dpr);
  const px = Math.max(0, cx - p.rect.x), py = Math.max(0, cy - p.rect.y);
  const button = action === 2 ? (pressed & 1 ? 1 : pressed & 4 ? 2 : pressed & 2 ? 3 : 0) : ({ 0: 1, 1: 3, 2: 2 }[e.button] || 0);
  return { t: 'mouse', id: p.id, action, button, mods: modsOf(e), px, py, x: Math.min(p.cols - 1, Math.floor(px / cellW)), y: Math.min(p.rows - 1, Math.floor(py / cellH)), detail: e.detail, pressed: pressed !== 0 };
}
const canvasXY = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
canvas.addEventListener('mousedown', (e) => {
  ime.focus();
  const p = paneAt(...canvasXY(e)) || focused;
  if (p !== focused) { focused = p; scheduleDraw(); }
  dragPane = p;
  const m = mouseMsg(e, 0, p);
  if (e.metaKey && e.button === 0) { port.postMessage({ t: 'link', id: p.id, x: m.x, y: m.y }); e.preventDefault(); return; }   // Cmd+click opens an OSC 8 link
  pressed |= 1 << e.button; port.postMessage(m); e.preventDefault();
});
window.addEventListener('mouseup', (e) => { if (!pressed || !dragPane) return; port.postMessage(mouseMsg(e, 1, dragPane)); pressed &= ~(1 << e.button); });
let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now(); if (now - lastMove < 8) return; lastMove = now;   // ~120 Hz cap
  const p = pressed ? dragPane : paneAt(...canvasXY(e));
  if (p) port.postMessage(mouseMsg(e, 2, p));
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = paneAt(...canvasXY(e)); if (!p) return;
  const m = mouseMsg(e, 0, p);
  const rowsDelta = Math.round(e.deltaY / (cellH / dpr)) || Math.sign(e.deltaY);
  port.postMessage({ t: 'wheel', id: p.id, delta: rowsDelta, mods: m.mods, px: m.px, py: m.py });
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- key->pixel latency probe (used by the benchmark; no cost when idle)
window.__latency = async (n) => {
  const out = [];
  const find = (ch) => { const p = focused, cy = p.cursor.y; for (let x = 0; x < p.cols; x++) if (p.shadow[(cy * p.cols + x) * 4] === ch.codePointAt(0)) return true; return false; };
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 120));
    const ch = 'xyzqwjk'[i % 7];
    const t0 = performance.now();
    // Resolved from the end of draw() itself (no rAF polling): key sent -> frame drawn (commands submitted to the GPU).
    const done = new Promise((res) => { probe = () => { if (find(ch)) { probe = null; res(performance.now()); } }; });
    send({ t: 'key', code: KEYMAP['Key' + ch.toUpperCase()], mods: 0, action: 1, utf8: ch, unshifted: ch.charCodeAt(0), composing: false });
    const t1 = await done;
    out.push(t1 - t0);
    send({ t: 'key', code: KEYMAP.Backspace, mods: 0, action: 1, utf8: null, unshifted: 0, composing: false });
  }
  probe = null;
  return out;
};

// ---------- wiring ----------
window.addEventListener('message', (e) => {
  if (e.data !== 'term-port' || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = ({ data }) => {
    const p = panes.get(data.id);
    if (data.t === 'frame') { if (p) { stats.tRecv = performance.now(); applyFrame(p, data.buf); scheduleDraw(); } }
    else if (data.t === 'exit') { if (p) closePane(p); }
    else if (data.t === 'stats') window.__hostStats = data;
    else if (data.t === 'clipboard') { window.__lastClip = data.text; if (data.text) navigator.clipboard.writeText(data.text).catch(() => {}); }
    else if (data.t === 'clipboard-write') { window.__lastOsc52 = data.text; navigator.clipboard.writeText(data.text).catch(() => {}); }   // only reaches us when the embedder set osc52: 'allow'
    else if (data.t === 'open-link') { window.__lastLink = data.uri; try { const u = new URL(data.uri); if (/^(https?|mailto):$/.test(u.protocol)) window.open(u.href); } catch { /* not a URL */ } }
  };
  newPane();
  ime.focus();
});
