'use strict';
// macOS phys_footprint of this process (includes compressed pages), in bytes.
const { execFileSync } = require('child_process');
function footprint(pid = process.pid) {
  const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' });
  const m = out.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB|B)/);
  if (!m) throw new Error('cannot parse footprint: ' + out.slice(0, 200));
  const mul = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[m[2]];
  return parseFloat(m[1]) * mul;
}
module.exports = { footprint };
