'use strict';
// xterm.js-style facade over the electron-ghostty renderer.  Load after keymap.js and renderer.js:
//   const { Terminal, FitAddon } = window.ghostty;
//   const term = new Terminal({ mode: 'external' });   // 'external': you feed bytes with write(), like xterm.js
//   term.open(container);                              // 'pty': the host process owns the shell, bytes never reach JS
//
// Rule of this file: an API is implemented only if it keeps the performance model (bytes parsed and scrollback kept
// in the native host, the page only holds the visible rows).  Everything else throws "not implemented" with the reason.
(function () {
  const NI = (what, why) => { throw new Error(`electron-ghostty: ${what} is not implemented${why ? ' (' + why + ')' : ''}`); };
  const warned = new Set();
  const warnOnce = (what) => { if (!warned.has(what)) { warned.add(what); console.warn(`electron-ghostty: option "${what}" is not implemented and is ignored`); } };
  const NO_BUFFER = 'scrollback lives in the native host; mirroring it into the page would cost the memory this library exists to save';
  const NO_PARSER = 'the parser runs in another thread/process and cannot call back into JS synchronously';

  class Emitter {
    constructor() { this.l = new Set(); }
    get event() { return (fn) => { this.l.add(fn); return { dispose: () => this.l.delete(fn) }; }; }
    fire(v) { for (const f of [...this.l]) f(v); }
  }

  const hex = (c) => {                                  // '#rgb' / '#rrggbb' -> 0xrrggbb; anything else unsupported
    if (typeof c !== 'string') return undefined;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
    if (!m) { warnOnce('theme color ' + c); return undefined; }
    let h = m[1]; if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return parseInt(h, 16);
  };
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  function themeToHost(t) {
    if (!t) return undefined;
    const out = {};
    const fg = hex(t.foreground), bg = hex(t.background), cur = hex(t.cursor);
    if (fg !== undefined) out.fg = fg; if (bg !== undefined) out.bg = bg; if (cur !== undefined) out.cursor = cur;
    if (ANSI.some((k) => t[k] !== undefined)) out.ansi = ANSI.map((k) => hex(t[k]));
    for (const k of ['cursorAccent', 'selectionBackground', 'selectionForeground', 'selectionInactiveBackground', 'extendedAnsi'])
      if (t[k] !== undefined) warnOnce('theme.' + k);
    return out;
  }

  const SUPPORTED_OPTIONS = new Set(['cols', 'rows', 'fontSize', 'fontFamily', 'theme', 'scrollback', 'mode']);
  const QUIET_OPTIONS = new Set(['allowProposedApi', 'allowTransparency', 'screenReaderMode', 'cursorBlink']);   // harmless to ignore

  class Terminal {
    constructor(options = {}) {
      this._opts = { cols: 80, rows: 24, fontSize: 14, scrollback: 100000, mode: 'external', ...options };
      this._fixed = options.cols !== undefined || options.rows !== undefined;
      this._cols = this._opts.cols; this._rows = this._opts.rows;
      this._ev = { data: new Emitter(), bell: new Emitter(), title: new Emitter(), resize: new Emitter(), selection: new Emitter(),
        scroll: new Emitter(), cursor: new Emitter(), render: new Emitter(), key: new Emitter(), exit: new Emitter() };
      this._selText = ''; this._pending = []; this._ready = false; this._acks = new Map(); this._ackId = 1; this._ackBatch = [];
      this._chunks = []; this._flushing = false; this._addons = []; this._dec = new TextDecoder(); this._keyHandler = null;
      this._disposed = false;
      const self = this;
      this.options = new Proxy(this._opts, {
        set(o, k, v) {
          if (SUPPORTED_OPTIONS.has(k)) { o[k] = v; self._optionChanged(k, v); }
          else { o[k] = v; if (!QUIET_OPTIONS.has(k)) warnOnce(String(k)); }
          return true;
        },
      });
    }

    // ---------- lifecycle ----------
    get element() { return this._wrap; }
    get textarea() { return this._ime; }
    get cols() { return this._cols; }
    get rows() { return this._rows; }

    open(parent) {
      if (this._r) throw new Error('electron-ghostty: Terminal.open() was already called');
      const wrap = document.createElement('div');
      wrap.className = 'ghostty-terminal';
      wrap.style.cssText = 'position:relative;overflow:hidden;width:100%;height:100%';
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'display:block;width:100%;height:100%';
      const ime = document.createElement('textarea');
      ime.setAttribute('autocapitalize', 'off'); ime.setAttribute('autocomplete', 'off'); ime.setAttribute('autocorrect', 'off'); ime.setAttribute('spellcheck', 'false');
      ime.setAttribute('aria-label', 'Terminal input');
      ime.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;overflow:hidden';
      wrap.append(canvas, ime); parent.appendChild(wrap);
      this._wrap = wrap; this._canvas = canvas; this._ime = ime; this._parent = parent;
      this._r = createRenderer({
        canvas, ime, autofocus: false, fontFamily: this._opts.fontFamily, fontSize: this._opts.fontSize, closeOnExit: false,
        onEvent: (m) => this._onHost(m),
        keyFilter: (e) => { this._ev.key.fire({ key: e.key, domEvent: e }); return this._keyHandler ? this._keyHandler(e) !== false : true; },
        onRender: () => { if (this._ev.render.l.size) this._ev.render.fire({ start: 0, end: this._rows - 1 }); },
      });
      this._pane = this._r.newPane({ mode: this._opts.mode === 'pty' ? 'pty' : 'external', scrollbackLines: this._opts.scrollback, theme: themeToHost(this._opts.theme) });
      canvas.addEventListener('mousedown', () => ime.focus());
      if (this._fixed) this._sizeFixed();
    }

    dispose() {
      if (this._disposed) return; this._disposed = true;
      for (const a of this._addons.splice(0)) { try { a.dispose && a.dispose(); } catch { /* ignore */ } }
      if (this._r) this._r.dispose();
      if (this._wrap) this._wrap.remove();
      for (const e of Object.values(this._ev)) e.l.clear();
    }

    // ---------- sizing ----------
    _sizeFixed() {
      const c = this._r.cell;
      this._wrap.style.width = Math.ceil((this._cols * c.w) / c.dpr) + 'px';
      this._wrap.style.height = Math.ceil((this._rows * c.h) / c.dpr) + 'px';
    }
    _enterFit() { this._fixed = false; if (this._wrap) { this._wrap.style.width = '100%'; this._wrap.style.height = '100%'; } }
    resize(cols, rows) {
      this._cols = cols; this._rows = rows; this._fixed = true;
      if (this._r) this._sizeFixed();
    }
    _optionChanged(k, v) {
      if (!this._r) return;
      if (k === 'fontSize' || k === 'fontFamily') { this._r.setFont(this._opts.fontFamily, this._opts.fontSize); if (this._fixed) this._sizeFixed(); }
      else if (k === 'theme') this._r.sendTo(this._pane, { t: 'theme', theme: themeToHost(v) });
      else if (k === 'cols' || k === 'rows') this.resize(this._opts.cols, this._opts.rows);
      else if (k === 'scrollback') warnOnce('scrollback after open()');
    }

    // ---------- host events ----------
    _onHost(m) {
      switch (m.t) {
        case 'resized':
          this._ready = true;
          if (m.cols !== this._cols || m.rows !== this._rows) { this._cols = m.cols; this._rows = m.rows; this._ev.resize.fire({ cols: m.cols, rows: m.rows }); }
          else if (m.initial) this._ev.resize.fire({ cols: m.cols, rows: m.rows });
          this._flush();
          break;
        case 'data': this._ev.data.fire(this._dec.decode(m.buf, { stream: true })); break;
        case 'bell': this._ev.bell.fire(); break;
        case 'title': this._ev.title.fire(m.title); break;
        case 'selection': this._selText = m.text; this._ev.selection.fire(); break;
        case 'scroll': this._ev.scroll.fire(m.pos); break;
        case 'cursor': this._ev.cursor.fire(); break;
        case 'exit': this._ev.exit.fire(m.status); break;
        case 'ack': for (const id of m.acks) { const cb = this._acks.get(id); if (cb) { this._acks.delete(id); cb(); } } break;
      }
    }
    onData(fn) { return this._ev.data.event(fn); }
    onBell(fn) { return this._ev.bell.event(fn); }
    onTitleChange(fn) { return this._ev.title.event(fn); }
    onResize(fn) { return this._ev.resize.event(fn); }
    onSelectionChange(fn) { return this._ev.selection.event(fn); }
    onScroll(fn) { return this._ev.scroll.event(fn); }
    onCursorMove(fn) { return this._ev.cursor.event(fn); }
    onRender(fn) { return this._ev.render.event(fn); }
    /** `key` is the DOM key, not the escape sequence xterm.js reports (the encoder runs in the host). */
    onKey(fn) { return this._ev.key.event(fn); }
    /** Not in xterm.js: the child process exited (mode 'pty'). */
    onExit(fn) { return this._ev.exit.event(fn); }
    onBinary() { NI('onBinary', 'no binary input channel; mouse/key bytes arrive through onData'); }
    onLineFeed() { NI('onLineFeed', NO_PARSER); }
    onWriteParsed() { NI('onWriteParsed', NO_PARSER); }
    onAddonsLoaded() { NI('onAddonsLoaded'); }

    // ---------- data in ----------
    write(data, callback) {
      if (typeof data === 'string') data = new TextEncoder().encode(data);
      this._chunks.push(data);
      if (callback) { const id = this._ackId++; this._acks.set(id, callback); this._ackBatch.push(id); }
      if (!this._flushing) { this._flushing = true; queueMicrotask(() => { this._flushing = false; this._flush(); }); }
    }
    writeln(data, callback) { this.write(typeof data === 'string' ? data + '\r\n' : data, callback); if (typeof data !== 'string') this.write('\r\n'); }
    _flush() {
      if (!this._ready || !this._chunks.length) return;
      let buf;
      if (this._chunks.length === 1) { const c = this._chunks[0]; buf = c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice(); }
      else { let n = 0; for (const c of this._chunks) n += c.byteLength; buf = new Uint8Array(n); let o = 0; for (const c of this._chunks) { buf.set(c, o); o += c.byteLength; } }
      this._chunks.length = 0;
      const ack = this._ackBatch; this._ackBatch = [];
      this._r.sendTo(this._pane, { t: 'write', buf, ack });
    }
    paste(text) { this._r.sendTo(this._pane, { t: 'paste', text }); }
    /** As if typed: encoded bytes come back through onData (mode 'external') or go to the PTY (mode 'pty'). */
    input(data) { this._r.sendTo(this._pane, { t: 'text', text: data }); }
    focus() { if (this._r) this._r.focus(); }
    blur() { if (this._ime) this._ime.blur(); }
    clear() { this.write('\x1b[2J\x1b[3J\x1b[H'); }
    reset() { this.write('\x1bc'); }
    refresh() { /* rendering is automatic */ }
    clearTextureAtlas() { if (this._r) this._r.layout(); }

    // ---------- scrolling ----------
    scrollLines(n) { this._r.sendTo(this._pane, { t: 'scrollLines', delta: n | 0 }); }
    scrollPages(n) { this.scrollLines(n * this._rows); }
    scrollToTop() { this.scrollLines(-1e7); }
    scrollToBottom() { this.scrollLines(1e7); }
    scrollToLine(line) { this.scrollLines(line - (this._pane.scrollOffset || 0)); }

    // ---------- selection (text is cached from host events, so these are synchronous like xterm.js) ----------
    hasSelection() { return this._selText.length > 0; }
    /** Cached when the selection changes; capped at 1 MiB. */
    getSelection() { return this._selText; }
    selectAll() { this._r.sendTo(this._pane, { t: 'selectAll' }); }
    clearSelection() { this._r.sendTo(this._pane, { t: 'clearSelection' }); }
    /** Visible rows only (row is a buffer row, as in xterm.js). */
    select(column, row, length) {
      const y = row - (this._pane.scrollOffset || 0), c = this._cols;
      if (y < 0 || y >= this._rows) NI('select() outside the visible rows', NO_BUFFER);
      const end = column + length - 1;
      this._r.sendTo(this._pane, { t: 'selectRange', x1: column, y1: y, x2: end % c, y2: y + Math.floor(end / c) });
    }
    selectLines(start, end) {
      const vy = this._pane.scrollOffset || 0;
      if (start - vy < 0 || end - vy >= this._rows) NI('selectLines() outside the visible rows', NO_BUFFER);
      this._r.sendTo(this._pane, { t: 'selectRange', x1: 0, y1: start - vy, x2: this._cols - 1, y2: end - vy });
    }
    getSelectionPosition() { NI('getSelectionPosition', NO_BUFFER); }

    // ---------- buffer: the visible rows only ----------
    get buffer() {
      const t = this, p = () => t._pane;
      const active = {
        get cursorX() { return p().curX || 0; }, get cursorY() { return p().curY || 0; },
        get viewportY() { return p().scrollOffset || 0; },
        get baseY() { return Math.max(0, (p().scrollTotal || t._rows) - t._rows); },
        get length() { return p().scrollTotal || t._rows; },
        get type() { NI('buffer.active.type', 'alternate-screen state is not mirrored into the page'); },
        getLine(y) {
          const pane = p(), vy = pane.scrollOffset || 0, ry = y - vy;
          if (!pane.shadow || ry < 0 || ry >= pane.rows) return undefined;         // outside the visible rows: not available
          const cols = pane.cols, sh = pane.shadow;
          return {
            length: cols, isWrapped: false,
            translateToString(trimRight = false, start = 0, end = cols) {
              let s = '';
              for (let x = start; x < Math.min(end, cols); x++) {
                const i = (ry * cols + x) * 4, wide = (sh[i + 3] >> 16) & 3;
                if (wide === 3) continue;
                s += sh[i] ? String.fromCodePoint(sh[i]) : ' ';
              }
              return trimRight ? s.replace(/\s+$/, '') : s;
            },
            getCell() { NI('IBufferLine.getCell', NO_BUFFER); },
          };
        },
        getNullCell() { NI('buffer.getNullCell'); },
      };
      return { active, get normal() { NI('buffer.normal', NO_BUFFER); }, get alternate() { NI('buffer.alternate', NO_BUFFER); },
        onBufferChange() { NI('buffer.onBufferChange', NO_BUFFER); } };
    }

    // ---------- addons ----------
    loadAddon(addon) { this._addons.push(addon); addon.activate(this); }
    attachCustomKeyEventHandler(fn) { this._keyHandler = fn; }
    attachCustomWheelEventHandler() { NI('attachCustomWheelEventHandler'); }

    // ---------- explicitly not implemented ----------
    get parser() { return new Proxy({}, { get: (_, k) => () => NI('parser.' + String(k), NO_PARSER) }); }
    get unicode() { NI('unicode', 'Unicode width/grapheme handling is done natively by libghostty'); }
    get modes() { NI('modes', 'terminal mode flags are not mirrored into the page'); }
    get markers() { NI('markers', NO_BUFFER); }
    registerMarker() { NI('registerMarker', NO_BUFFER); }
    registerDecoration() { NI('registerDecoration', NO_BUFFER); }
    registerLinkProvider() { NI('registerLinkProvider', 'links are OSC 8 hyperlinks opened with Cmd+click'); }
    registerCharacterJoiner() { NI('registerCharacterJoiner'); }
    deregisterCharacterJoiner() { NI('deregisterCharacterJoiner'); }
    registerCsiHandler() { NI('registerCsiHandler', NO_PARSER); }
    registerDcsHandler() { NI('registerDcsHandler', NO_PARSER); }
    registerEscHandler() { NI('registerEscHandler', NO_PARSER); }
    registerOscHandler() { NI('registerOscHandler', NO_PARSER); }
    getOption(k) { return this._opts[k]; }
    setOption(k, v) { this.options[k] = v; }
  }

  class FitAddon {
    activate(t) { this._t = t; }
    dispose() { this._t = null; }
    proposeDimensions() {
      const t = this._t; if (!t || !t._r) return undefined;
      const { w, h, dpr } = t._r.cell, el = t._parent.getBoundingClientRect();
      if (!el.width || !el.height) return undefined;
      return { cols: Math.max(2, Math.floor((el.width * dpr) / w)), rows: Math.max(1, Math.floor((el.height * dpr) / h)) };
    }
    fit() { if (this._t) this._t._enterFit(); }
  }
  // The renderer is already GPU-driven; these exist so code written for xterm.js keeps loading.
  class WebglAddon { activate() {} dispose() {} onContextLoss() { return { dispose() {} }; } }
  class CanvasAddon extends WebglAddon {}
  class SearchAddon { activate() { NI('SearchAddon', NO_BUFFER); } dispose() {} }
  class SerializeAddon { activate() { NI('SerializeAddon', NO_BUFFER); } dispose() {} }
  class WebLinksAddon { activate() { NI('WebLinksAddon', 'OSC 8 hyperlinks are supported natively; plain-text URL matching needs the scrollback'); } dispose() {} }

  const api = { Terminal, FitAddon, WebglAddon, CanvasAddon, SearchAddon, SerializeAddon, WebLinksAddon };
  window.ghostty = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
