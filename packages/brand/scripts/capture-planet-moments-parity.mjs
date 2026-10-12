// Capture U9a's independent lab choreography before moving it. No product-moments import.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { PLANET_SCENE_RENDERER, PLANET_SAMPLER } from '../planet.mjs';

const lab = new URL('../../../.happier/design-lab/atmosphere/', import.meta.url);
const read = (name) => readFileSync(new URL(name, lab), 'utf8');
const sources = ['mo-scenes.js', 'mo-scenes2.js'].map(read);
if (sources.some((s) => s.includes('planet-moments'))) throw new Error('Lab already consumes the product moments: refusing to overwrite the reference.');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Canvas, image readiness, layout and animation scheduling are browser boundaries.
// The recorder observes every drawing argument; the original internal maths runs intact.
function recording() {
  const commands = []; let gradient = 0;
  const c = new Proxy({}, {
    set(_target, key, value) { commands.push(['set', key, value]); return true; },
    get(_target, key) {
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return (...args) => {
        const id = gradient++; commands.push([key, id, ...args]);
        return { gradient: id, addColorStop: (...stop) => commands.push(['addColorStop', id, ...stop]) };
      };
      return (...args) => commands.push([key, ...args.map((a) => a && a.complete ? 'happier-mark' : a)]);
    },
  });
  return { c, commands };
}
const realm = { console, TextEncoder, BRAND_PACKAGE: { PLANET_SCENE_RENDERER }, BRAND_PLANET: PLANET_SAMPLER, Image: class { complete = true; }, window: null };
realm.window = realm;
vm.createContext(realm);
vm.runInContext(readFileSync(new URL('../daybreak/qrcore.js', lab), 'utf8'), realm);
const planet = read('mo-planet.js');
const helpers = planet.slice(planet.indexOf('const clamp ='), planet.indexOf('/* ═══ the PNG sampler'));
vm.runInContext(`(() => { ${helpers} window.MO = { clamp, mix, sstep, easeOut, easeInOut, crit, hash, rgba, BODY, COOL, ramp, digitOf, MONO, ready: Promise.resolve(), RM: false }; })()`, realm);
// This is the lab's real U1-backed collapse sampler, not a fabricated list of target dots.
const cellsSource = planet.slice(planet.indexOf('function planetCells(o)'), planet.indexOf('// a window onto a planet'));
vm.runInContext(`(() => { const { resolve, brandDots } = BRAND_PACKAGE.PLANET_SCENE_RENDERER; ${cellsSource} MO.planetCells = planetCells; })()`, realm);
vm.runInContext(sources[0].replace('window.MOS = MOS;', 'window.QR_REFERENCE = { qrModel }; window.MOS = MOS;'), realm);
vm.runInContext(sources[1], realm);

const texts = ['happier://pair?c=7Hq2-K9xN-4mZp&h=personal-home', 'happier://pair?c=R3vD-8kLw-Q2tB&h=personal-home', 'happier://pair?c=short'];
const matrices = texts.map((text) => { const q = realm.QRCore.create(text, { errorCorrectionLevel: 'Q' }); return { text, size: q.modules.size, data: Array.from(q.modules.data) }; });
const models = [];
for (const matrix of matrices) for (const S of [160, 224]) for (const dpr of [1, 2]) {
  const output = realm.QR_REFERENCE.qrModel(matrix.text, S, dpr);
  models.push({ matrix, S, dpr, sha256: digest(output), ...(models.length === 0 ? { output } : {}) });
}
const frames = [];
async function capture(moment, options, w, h, time) {
  const { c, commands } = recording(); const styles = [{}, {}];
  const ov = { getContext: () => c, dataset: { ring: '1' } };
  const el = { clientWidth: w, clientHeight: h, dataset: {}, nextElementSibling: ov,
    querySelector: (selector) => selector === 'canvas[data-ov]' ? ov : { style: styles[selector.includes('light') ? 0 : 1] } };
  realm.MO.ctxOf = () => ({ c, w, h, dpr: options.dpr || 1 });
  realm.MO.planet = (_c, opts) => commands.push(['planet', opts]);
  realm.getComputedStyle = () => ({ backgroundColor: '#F5F5F5' });
  realm.Atmos = { ripple: (_el, opts) => commands.push(['ripple', opts]) };
  realm.MOS[moment](el, { ...options, t: time });
  await Promise.resolve(); await Promise.resolve();
  const output = { commands: JSON.parse(JSON.stringify(commands)), styles };
  frames.push({ moment, options, w, h, time, sha256: digest(output), ...(frames.length === 0 ? { output } : {}) });
}
for (const theme of ['light', 'dark']) for (const S of [160, 224]) for (const dpr of [1, 2]) {
  for (const phase of ['assemble', 'reform', 'scan']) for (const time of [-0.1, 0, 0.18, 0.32, 0.57, 0.7, 0.9, 0.92, 1.6]) {
    await capture('qr', { theme, dpr, phase, text: texts[0], next: texts[1], wait: 0.25 }, S, S, time);
  }
}
for (const theme of ['light', 'dark']) for (const layout of ['wide', 'square']) {
  for (const phase of ['handoff', 'adding', 'joined']) for (const time of [-0.1, 0, 0.18, 0.36, 0.5, 0.8, 1.15]) {
    await capture('pair', { theme, layout, phase }, layout === 'wide' ? 440 : 224, layout === 'wide' ? 240 : 224, time);
  }
}
for (const [w, h] of [[1440, 940], [390, 844]]) for (const dir of ['sunrise', 'night']) {
  for (const time of [0, 0.25, 0.5, 0.75, 0.98, 1.2]) await capture('theme', { kind: 'horizon', dir }, w, h, time);
}
for (const theme of ['light', 'dark']) for (const time of [-0.1, 0, 0.18, 0.5, 1, 1.6]) await capture('ripple', { theme, px: 120, py: 92, R: 34 }, 340, 240, time);
const fixture = new URL('../fixtures/planet-moments-parity.json', import.meta.url);
writeFileSync(fixture, JSON.stringify({ header: { date: '2026-10-10', lab: '.happier/design-lab/atmosphere/{mo-scenes.js,mo-scenes2.js,mo-planet.js}', script: 'packages/brand/scripts/capture-planet-moments-parity.mjs', basis: 'Original U9 scene maths; previously extracted U1 sampler supplies collapse targets. Browser drawing arguments captured independently before extraction.' }, matrices, models, frames, timings: { QR: realm.MO_QR, SCAN: realm.MO_SCAN, PAIR: realm.MO_PAIR, TH: realm.MO_TH, RIP: realm.MO_RIP } }, null, 2) + '\n');
console.log(`Captured ${models.length} QR models and ${frames.length} moment frames.`);
