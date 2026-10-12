// Capture the independent lab reference BEFORE extraction. Never import the product owner here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const lab = new URL('.happier/design-lab/atmosphere/', root);
const fixture = new URL('../fixtures/planet-scene-parity.json', import.meta.url);
const read = (name) => readFileSync(new URL(name, lab), 'utf8');
if (read('mo-brand.js').includes('import(')) throw new Error('Lab already consumes the product: refusing to overwrite the reference.');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only browser boundaries are stubbed. All scene, sampler and choreography logic runs unchanged.
globalThis.window = globalThis;
globalThis.location = { search: '' };
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context() }),
  fonts: { load: async () => {} },
  documentElement: { dataset: {} },
};
globalThis.Image = class { set src(value) { queueMicrotask(() => this.onload()); } };
globalThis.DB_PNG = { dark: '', light: '', span: 3.2 };
globalThis.MOS = {};
globalThis.MO_LAB = { reg() {} };
function context() {
  return { setTransform() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, fillText() {},
    getImageData: () => ({ data: new Uint8ClampedArray(420 * 420 * 4) }) };
}
function expose(source, text) { return source.replace(/\}\)\(\);\s*$/, `${text}\n})();`); }
(0, eval)(read('mo-brand.js'));
(0, eval)(read('at-planet-geometry.js'));
(0, eval)(expose(read('mo-planet.js'), 'window.PARITY = { resolve, brandDots, fieldCells };'));
(0, eval)(expose(read('mo-r4.js'), 'window.CHOREOGRAPHY = { assembly, lightAt, maskAt, drawAssembly, ASM, W4, L4 };'));
await MO.ready;

const scene = (o) => {
  const P = PARITY.resolve(o, o.dpr || 1, o.view);
  const dots = PARITY.brandDots(P).map(({ x, y, r, rgb, op, i, j }) => ({ x, y, r, rgb, opacity: op, i, j }));
  const cells = PARITY.fieldCells(P).map(({ col, ...c }) => ({ ...c, rgb: col }));
  return { body: dots.filter((d) => Math.hypot((d.x - P.cx) / P.R, (d.y - P.cy) / P.R) < 1),
    haze: dots.filter((d) => Math.hypot((d.x - P.cx) / P.R, (d.y - P.cy) / P.R) >= 1), cells };
};
const scenes = [];
function addScene(id, options, full = false) {
  const output = scene(options);
  scenes.push({ id, options, sha256: digest(output), counts: [output.body.length, output.haze.length, output.cells.length], ...(full ? { output } : {}) });
}
for (const theme of ['light', 'dark']) for (const [w, h] of [[1440, 900], [390, 844]]) {
  for (const place of ['corner', 'side', 'rise']) for (const style of ['airy', 'balanced', 'rich']) {
    const options = { ...ATP.options(place, w, h, { phone: w === 390, theme, style }), view: { w, h } };
    addScene(`${theme}-${w}-${place}-${style}`, options);
  }
}
for (const theme of ['light', 'dark']) for (const tail of [0, 1.6]) for (const overStyle of ['ink', 'emboss']) {
  for (const rotate of [0, -1.5]) for (const mirror of [false, true]) for (const dpr of [1, 1.5, 2]) {
    addScene(`${theme}-variants-${tail}-${overStyle}-${rotate}-${mirror}-${dpr}`, {
      ...ATP.options('corner', 390, 844, { phone: true, theme }), tail, rotate, mirror, dpr,
      field: { around: 1, over: 0.62, overStyle, reach: { top: 3.2, right: 3.2, bottom: 1.9, left: 2.7 }, fall: 0.8, ink: theme === 'light' ? 1.15 : 0.8, start: 0.3, ramp: 0.6, seed: 3 },
      view: { w: 390, h: 844 }, time: 2.1, rate: 0.5,
    });
  }
}
addScene('diagnostic-small', { R: 26, cx: 42, cy: 36, view: { w: 90, h: 80 }, theme: 'light', field: { around: 1, cell: 12 } }, true);

const brand = [];
for (const theme of ['light', 'dark']) for (const size of [64, 320, 640]) for (const pose of ['ready', 'shadow', 'eclipse']) {
  const B = BRAND_PLANET, rows = Math.max(19, Math.round(size / B.HERO_DOT_PITCH)), pitch = size / rows, radius = size * 0.4;
  const reveal = pose === 'eclipse' ? 0.08 : pose === 'shadow' ? 0.34 : 1, palette = B.PLANET_PALETTES[theme];
  const sample = { palette, reveal, breath: 0, spin: B.REST_SPIN, light: B.lightForReveal(reveal), ...B.atmosphereForEnergy(0) };
  const output = Array.from({ length: rows * rows }, (_, id) => {
    const i = id % rows, j = Math.floor(id / rows), x = (i + 0.5) * pitch, y = (j + 0.5) * pitch;
    const px = (x - size / 2) / radius, py = (y - size / 2) / radius, d = Math.hypot(px, py);
    const sh = B.shadePlanetDot(px, py, i, j, sample); let rgb = sh.lit ? sh.rgb : null, opacity = rgb ? 1 : 0;
    if (rgb && d >= 1) { rgb = B.gradient(palette.halo, Math.min(1, Math.max(0, (py + 1) / 2 - px * 0.2))); opacity = B.haloOpacity(theme, d); }
    return { id, x, y, radius: pitch * B.DOT_RADIUS, rgb: (rgb ? B.inkDot(rgb, theme) : palette.background).map(Math.round), opacity };
  });
  brand.push({ options: { theme, size, pose }, sha256: digest(output) });
}

const assemblies = [];
for (const theme of ['light', 'dark']) {
  const options = { R: 112, cx: 180, cy: 165, theme, view: { w: 360, h: 330 }, field: { reach: { bottom: 1.22 } } };
  const A = CHOREOGRAPHY.assembly(options, 1, options.view);
  const output = { body: A.body, patches: A.patches, field: A.field, R: A.R, g: A.g };
  assemblies.push({ options, sha256: digest(output), ...(theme === 'light' ? { output } : {}) });
}
const light = [];
for (const time of [0, 0.25, 0.5, 1, 1.9]) for (const [px, py] of [[0, 0], [0.8, -0.6], [-0.7, 0.3], [1.2, 0.2]]) {
  light.push({ px, py, k: time / 1.9, light: CHOREOGRAPHY.lightAt(px, py, time / 1.9), mask: CHOREOGRAPHY.maskAt(px, py, time / 1.9) });
}

// Instrument the real drawAssembly call to capture its inputs, without replacing its maths or drawing.
const frameSource = expose(read('mo-r4.js').replace('function drawAssembly(c, A, f) {', 'function drawAssembly(c, A, f) { window.FRAME_INPUT = { A, f };'), '');
(0, eval)(frameSource);
const frames = [];
for (const moment of ['welcome', 'loading']) for (const theme of ['light', 'dark']) for (const time of [0, 0.25, 0.5, 1, 1.9]) {
  const ctx = context(); ctx.fillRect = () => {}; ctx.rect = () => {}; ctx.clip = () => {}; ctx.clearRect = () => {};
  const el = { clientWidth: 360, clientHeight: 330, width: 360, height: 330, getContext: () => ctx, parentElement: { querySelector: () => null } };
  window.FRAME_INPUT = null;
  ctx.canvas = el;
  MOS[moment + '4'](el, { t: time, dpr: 1, theme, ready: moment === 'loading' ? 0.4 : undefined, R: 112, cy: 0.5 });
  await Promise.resolve();
  const input = window.FRAME_INPUT;
  if (!input) { frames.push({ moment, theme, time, ready: 0.4, assembly: false }); continue; }
  const { A, f } = input;
  const values = { t: f.t, prog: f.prog, alpha: f.alpha ?? 1, halo: f.halo, fieldU: f.fieldU, t0: f.t0 ?? 0, retype: f.retype ?? 0,
    patches: A.patches.map((p) => ({ landT: f.landT(p), appear: f.appear(p), loose: f.loose ? f.loose(p) : 0 })) };
  frames.push({ moment, theme, time, ready: 0.4, assembly: true, sha256: digest(values) });
}
mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true });
writeFileSync(fixture, JSON.stringify({ header: { lab: '.happier/design-lab/atmosphere/{mo-brand.js,mo-planet.js,mo-r4.js,at-planet-geometry.js}', date: '2026-10-10', script: 'packages/brand/scripts/capture-planet-parity.mjs', phoneCornerReachBottom: 1.9 }, scenes, brand, assemblies, light, frames, timings: { ASM: CHOREOGRAPHY.ASM, W4: CHOREOGRAPHY.W4, L4: CHOREOGRAPHY.L4 } }, null, 2) + '\n');
console.log(`Captured ${scenes.length} scenes, ${brand.length} brand cases, ${frames.length} choreography frames to ${fileURLToPath(fixture)}`);
