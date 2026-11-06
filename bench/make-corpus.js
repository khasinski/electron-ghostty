'use strict';
// Writes the benchmark corpus (real source text, CRLF) used by the end-to-end benchmarks.
const fs = require('fs'), path = require('path');
const { realLines } = require('./payload');
const lines = +process.argv[2] || 1000000;
const out = path.join(__dirname, 'e2e', 'corpus.txt');
fs.writeFileSync(out, realLines(lines));
console.log(out, (fs.statSync(out).size / 1048576).toFixed(1) + ' MB,', lines, 'lines');
