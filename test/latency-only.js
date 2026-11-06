module.exports = async (win) => {
  await new Promise((r) => setTimeout(r, 2500));
  const lat = (await win.webContents.executeJavaScript('window.__latency(40)')).sort((a, b) => a - b);
  console.log('LATENCY ghostty ms: median', lat[20].toFixed(1), 'p95', lat[38].toFixed(1), 'min', lat[0].toFixed(1), 'max', lat[39].toFixed(1));
  if (false) { const m = await win.webContents.executeJavaScript('window.__marks.slice(0,8)'); console.log(m.map((x) => Object.entries(x).map(([k, v]) => k + '=' + v.toFixed(1)).join(' ')).join('\n')); }
};
