'use strict';
// Concatenates the three browser scripts into one file for the page: dist/electron-ghostty.js (sets window.ghostty).
const fs = require('fs'), path = require('path');
const app = path.join(__dirname, '..', 'app');
const out = ['keymap.js', 'renderer.js', 'terminal.js'].map((f) => `/* ${f} */\n${fs.readFileSync(path.join(app, f), 'utf8')}`).join('\n;\n');
fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'dist', 'electron-ghostty.js'), out);
console.log('dist/electron-ghostty.js', out.length, 'bytes');
