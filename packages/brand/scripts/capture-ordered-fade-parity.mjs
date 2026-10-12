// Capture the lab's Home planet foot fade (`at-planet.js` orderedFade) before it moves to the package.
// No product import: the lab function runs as written against an in-memory canvas boundary.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const labPath = '.happier/design-lab/atmosphere/at-planet.js';
const source = readFileSync(
  new URL(`../../../${labPath}`, import.meta.url),
  'utf8',
);
if (source.includes('BRAND_ATMOSPHERE') || source.includes('packages/brand')) {
  throw new Error(
    'Lab already consumes the product fade: refusing to overwrite the reference.',
  );
}
const start = source.indexOf('const BAYER8 = [');
const end =
  source.indexOf('\n}\n', source.indexOf('function orderedFade(')) + 2;
if (start < 0 || end < 2) throw new Error('Lab orderedFade not found');
const labOrderedFade = new Function(
  `${source.slice(start, end)}\nreturn orderedFade;`,
)();

// The canvas is the browser boundary; its pixel store is a plain RGBA buffer.
function canvasOf(rgba, width, height) {
  const data = new Uint8ClampedArray(rgba);
  const context = {
    save() {},
    restore() {},
    setTransform() {},
    clearRect(x, y, w, h) {
      for (let row = y; row < y + h; row++)
        data.fill(0, (row * width + x) * 4, (row * width + x + w) * 4);
    },
    getImageData(x, y, w, h) {
      return {
        data: data.slice((y * width + x) * 4, ((y + h) * width + x) * 4),
      };
    },
    putImageData(image, x, y) {
      data.set(image.data, (y * width + x) * 4);
    },
  };
  return { width, height, data, getContext: () => context };
}
// Deterministic, partly transparent input: the fade only touches pixels with alpha.
function input(width, height, seed) {
  const out = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let k = 0; k < out.length; k++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[k] = (k & 3) === 3 && s >>> 28 < 3 ? 0 : s >>> 24;
  }
  return out;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cases = [];
const add = (id, width, height, y0, y1, dpr, full = false) => {
  const rgba = input(width, height, cases.length + 7);
  const canvas = canvasOf(rgba, width, height);
  labOrderedFade(canvas, y0, y1, dpr);
  cases.push({
    id,
    width,
    height,
    y0,
    y1,
    dpr,
    seed: cases.length + 7,
    sha256: sha(canvas.data),
    ...(full ? { rgba: Buffer.from(canvas.data).toString('base64') } : {}),
  });
};
add('window-inside/dpr1', 64, 48, 10, 40, 1, true);
add('window-inside/dpr2', 128, 96, 10, 40, 2);
add('window-to-foot/dpr2', 128, 96, 18.5, 48, 2);
add('window-past-foot/dpr1', 64, 48, 30, 80, 1);
add('window-below-canvas/dpr1', 64, 48, 60, 90, 1);
add('fractional/dpr1.5', 96, 72, 7.25, 33.75, 1.5);
add('home-rise-window/dpr2', 160, 120, 20, 50, 2, true);

const out = new URL('../fixtures/ordered-fade-parity.json', import.meta.url);
writeFileSync(
  out,
  `${JSON.stringify({ capturedFrom: labPath, capturedBy: 'packages/brand/scripts/capture-ordered-fade-parity.mjs', cases }, null, 1)}\n`,
);
console.log(`captured ${cases.length} cases`);
