'use strict';
// Shared page logic: load corpus, feed it in 64 KB chunks (one task each), resolve when the terminal reports the last write parsed.
window.__feed = async (write) => {
  const buf = new Uint8Array(await (await fetch('../e2e/corpus.txt')).arrayBuffer());
  const CH = 65536, mc = new MessageChannel(), tick = () => new Promise((r) => { mc.port1.onmessage = r; mc.port2.postMessage(0); });
  const t0 = performance.now();
  let last;
  for (let o = 0; o < buf.length; o += CH) {
    const chunk = buf.slice(o, Math.min(o + CH, buf.length));   // a fresh buffer per delivery, like an IPC message or a PTY read
    if (o + CH >= buf.length) last = new Promise((r) => write(chunk, r)); else write(chunk);
    await tick();
  }
  await last;
  return (performance.now() - t0) / 1000;
};
