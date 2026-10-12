// Capture only from the pre-extraction lab owner; never regenerate references from product code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = new URL('../../../', import.meta.url);
const lab = new URL('.happier/design-lab/atmosphere/atmos-core.js', root);
const code = await readFile(lab, 'utf8');
if (!code.includes('function runJob(job)') || code.includes('packages/brand')) {
  throw new Error('Capture requires the original lab core. Existing references must not be regenerated from the port.');
}
const { runJob, FX, DISSOLVES, makeTransition, cropOf, drawRippleRing, lattice, makeTone, rampAt, hash } = await import(lab.href);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const w = 96, h = 64;
const pictures = [
  { id: 'calm-sea', file: 'plates/calmsea-courbet.jpg', hour: 11, hz: 0.76, adjust: { temperature: -0.7, saturation: 1.25, contrast: 1.1 } },
  { id: 'p501', file: 'photos/p501.jpg', hour: 12, hz: 0.5 },
  { id: 'ship-by-moonlight', file: 'plates/shipmoon-aivazovsky.jpg', hour: 22, hz: 0.55 },
];
const inputs = {};
for (const p of pictures) {
  const file = new URL('.happier/design-lab/landscapes/assets/' + p.file, root);
  const { data, info } = await sharp(file.pathname).resize(w, h, { fit: 'cover' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  inputs[p.id] = { file: p.file, w: info.width, h: info.height, rgba: data.toString('base64') };
}
const cases = [];
const add = (id, input, opts, full = false) => {
  const src = Buffer.from(inputs[input].rgba, 'base64');
  const out = new Uint8ClampedArray(runJob({ W: w, H: h, dpr: 1, src, ...opts }).buffer);
  cases.push({ id, input, job: opts, sha256: sha(out), ...(full ? { rgba: Buffer.from(out).toString('base64') } : {}) });
};
for (const p of pictures) for (const dark of [false, true]) for (const effect of Object.keys(FX)) {
  add(`${p.id}/${dark ? 'dark' : 'light'}/${effect}`, p.id, {
    effect, dark, page: dark ? [19, 17, 17] : [245, 245, 245], mute: dark ? 0.08 : 0.05,
    grade: { from: p.hour, to: dark ? 22 : p.hour === 22 ? 6.4 : p.hour, hz: p.hz },
    adjust: p.adjust || null, params: {}, strength: 0.83, dissolve: { style: 'ordered', from: 0.55, to: 1 },
  }, effect === 'fine');
}
for (const d of DISSOLVES) for (const effect of ['original', 'fine', 'halftone', 'engraving']) {
  add(`dissolve/${effect}/${d.id}`, 'p501', { effect, dark: false, page: [245, 245, 245], params: {}, dissolve: { style: d.id, from: 0.23, to: 0.94 } });
}
for (const effect of Object.keys(FX)) for (const x of [0, w]) {
  add(`span/${effect}/${x}`, 'calm-sea', { effect, dark: true, page: [19, 17, 17], params: {}, span: { x, y: 8, W: w * 2, H: h + 8 }, dissolve: { style: 'ordered', from: 0.4, to: 1 } });
}
// Atlas supplied by the platform: deterministic masks exercise the original 10-glyph layout without font dependencies.
const L = lattice(w, h, 1);
const masks = Uint8Array.from({ length: L.cw * L.ch * 10 }, (_, i) => (i * 37 + (i >> 3) * 11) & 255);
const glyphs = { cw: L.cw, ch: L.ch, chars: '0123456789', masks };
const frames = [];
const A = { W: w, H: h, data: new Uint8ClampedArray(Buffer.from(inputs['p501'].rgba, 'base64')) };
const B = { W: w, H: h, data: new Uint8ClampedArray(Buffer.from(inputs['calm-sea'].rgba, 'base64')) };
for (const style of ['crossfade', 'resettle', 'ripple']) {
  const T = makeTransition(A, B, style, [245, 245, 245], false, 1, { glyphs });
  for (const t of [0, 0.25, 0.5, 1]) frames.push({ style, t, sha256: sha(T.frame(t)) });
}
const overlays = [];
for (const dark of [false, true]) for (const t of [0.25, 0.5, 1]) {
  const buf = new Uint8ClampedArray(w * h * 4);
  drawRippleRing({ buf, W: w, H: h, L, at: glyphs, page: dark ? [19, 17, 17] : [245, 245, 245], dark, tone: makeTone(dark ? [19, 17, 17] : [245, 245, 245], dark), ox: w * 0.85, oy: h * 0.25, Rmax: Math.max(Math.hypot(w * 0.85, h * 0.25), Math.hypot(w * 0.15, h * 0.25), Math.hypot(w * 0.85, h * 0.75), Math.hypot(w * 0.15, h * 0.75)) * 0.9, dpr: 1, overlay: true, colourAt: (c, u, i, j) => rampAt(dark ? 0.6 + 0.25 * hash(i, j, 95) : (hash(i, j, 95) < 0.5 ? 0.62 : 0.22)) }, t);
  overlays.push({ dark, t, sha256: sha(buf) });
}
const crops = [];
for (const span of [{ W: 192, H: 64 }, { W: 64, H: 128 }]) {
  const source = { w: 1280, h: 853 }, focus = { x: 0.62, zoom: 1.2 }, horizon = { src: 0.76, at: 0.6 };
  const crop = cropOf(source, span.W, span.H, focus, horizon);
  crops.push({ source, span, focus, horizon, expected: { s: crop.s, sx: crop.sx, sy: crop.sy, vw: crop.vw, vh: crop.vh, horizon: crop.toBand(0.76) } });
}
const fixture = { captured: new Date().toISOString(), labPath: '.happier/design-lab/atmosphere/atmos-core.js', labOrigin: '.happier/design-lab/atmosphere/atmos-engine.js (v2, captured before extraction)', script: 'packages/brand/scripts/capture-atmosphere-parity.mjs', decoder: 'existing repository sharp; fixed 96 × 64 RGBA inputs stored below', w, h, inputs, cases, glyphs: { ...glyphs, masks: Buffer.from(masks).toString('base64') }, frames, overlays, crops };
const dest = new URL('../fixtures/atmosphere-parity.json', import.meta.url);
await mkdir(new URL('.', dest), { recursive: true });
await writeFile(dest, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Captured ${cases.length} backdrop outputs, ${frames.length} transition frames, ${overlays.length} overlays and ${crops.length} crop references from the lab.`);
