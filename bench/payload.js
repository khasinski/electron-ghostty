'use strict';
// Deterministic benchmark payloads shared by all engines.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Colored text lines: `cols` visible chars, SGR change every ~16 chars, CRLF terminated.
function coloredLines(lines, cols = 200, seed = 1) {
  const r = rng(seed);
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789 ._-/';
  const parts = [];
  for (let l = 0; l < lines; l++) {
    let line = '';
    for (let c = 0; c < cols; c += 16) {
      line += `\x1b[38;5;${(r() * 256) | 0}m`;
      const n = Math.min(16, cols - c);
      for (let i = 0; i < n; i++) line += alpha[(r() * alpha.length) | 0];
    }
    parts.push(line + '\x1b[0m\r\n');
  }
  return Buffer.from(parts.join(''), 'latin1');
}

// Plain ASCII (like `cat file`).
function plainLines(lines, cols = 200, seed = 2) {
  const r = rng(seed);
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789 ._-/';
  const parts = [];
  for (let l = 0; l < lines; l++) {
    let line = '';
    for (let i = 0; i < cols; i++) line += alpha[(r() * alpha.length) | 0];
    parts.push(line + '\r\n');
  }
  return Buffer.from(parts.join(''), 'latin1');
}

function chunks(buf, size = 65536) {
  const out = [];
  for (let o = 0; o < buf.length; o += size) out.push(buf.subarray(o, Math.min(o + size, buf.length)));
  return out;
}

// Real text: source files from the vendored ghostty tree, CRLF-terminated, no repetition.
function realLines(lines) {
  const fs = require('fs'), path = require('path');
  const out = []; let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (n >= lines) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(zig|c|h|md|swift|txt)$/.test(e.name)) {
        for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
          if (n >= lines) return;
          out.push(l.replace(/[^\x20-\x7e]/g, '?') + '\r\n'); n++;
        }
      }
    }
  };
  walk(path.join(__dirname, '..', 'vendor', 'ghostty'));
  if (n < lines) throw new Error('corpus too small: ' + n);
  return Buffer.from(out.join(''), 'latin1');
}

const mb = (n) => (n / 1048576).toFixed(1);
module.exports = { realLines, coloredLines, plainLines, chunks, mb };
