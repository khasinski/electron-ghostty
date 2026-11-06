'use strict';
// Kitty graphics: transmit+display a 2x2 RGB image scaled to 12x6 cells, verify texture, placement and pixel colors.
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (win) => {
  const ev = (c) => win.webContents.executeJavaScript(c + '; ');
  await sleep(1500);
  const b64 = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]).toString('base64');
  await ev('sendInput(' + JSON.stringify(`printf '\\033_Ga=T,f=24,s=2,v=2,c=12,r=6;${b64}\\033\\\\\\n'\r`) + ')');
  for (let i = 0; i < 40 && !(await ev('window.__ghostty.images')); i++) await sleep(100);
  assert.strictEqual(await ev('window.__ghostty.images'), 1, 'image texture uploaded');
  await sleep(300);
  const cap = await win.webContents.capturePage(), img = cap.toBitmap();   // BGRA, device pixels
  const width = cap.getSize({ scaleFactor: 1 }).width * 0 + Math.round(Math.sqrt(img.length / 4 * (cap.getAspectRatio())));
  const px = (x, y) => { const o = (y * width + x) * 4; return [img[o + 2], img[o + 1], img[o]]; };
  const dpr = await ev('dpr'), ch = await ev('cellH'), cw = await ev('cellW');
  // top-left corner of the first image row (rows 1-6, right under the echoed command) is near red, bottom-right near white
  const x0 = 2, y0 = Math.round(1 * ch) + 4, x1 = Math.round(12 * cw) - 3, y1 = Math.round(7 * ch) - 3;   // cellW/cellH are device px, like the bitmap
  const tl = px(x0, y0), br = px(x1, y1);
  assert(tl[0] > 200 && tl[1] < 90 && tl[2] < 90, 'top-left is red: ' + tl);
  assert(br[0] > 200 && br[1] > 200 && br[2] > 200, 'bottom-right is white: ' + br);
  console.log('kitty graphics ok', tl, br);
};
