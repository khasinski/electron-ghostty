'use strict';
// Loads the native addon: prebuilds/<platform>-<arch>/ (shipped in the npm package) or build/Release (local build).
const path = require('path');
let addon;
try {
  addon = require('node-gyp-build')(path.join(__dirname, '..'));
} catch (e) {
  throw new Error(
    `electron-ghostty: no native build for ${process.platform}-${process.arch} (Node ${process.versions.node}` +
    `${process.versions.electron ? ', Electron ' + process.versions.electron : ''}). ` +
    'Supported prebuilds: macOS arm64/x64, Linux x64/arm64. To build from source see the README. Original error: ' + e.message);
}
module.exports = addon;
