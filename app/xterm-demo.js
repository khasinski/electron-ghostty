'use strict';
// Usage example and test target: the same code you would write for xterm.js.
const { Terminal, FitAddon, WebglAddon } = window.ghostty;
const params = new URLSearchParams(location.search);
const term = new Terminal({ mode: params.get('mode') || 'external', fontSize: 14 });
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebglAddon());
term.open(document.getElementById('t'));
fit.fit();
window.term = term;
if (term.options.mode === 'external') {
  // no shell: echo what the user types, as an app with its own PTY would do
  term.write('electron-ghostty, xterm-style API (external mode)\r\n$ ');
  term.onData((d) => term.write(d === '\r' ? '\r\n$ ' : d));
}
term.focus();
