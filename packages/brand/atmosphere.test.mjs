import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as atmosphere from '@happier-dev/brand/atmosphere';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/atmosphere-parity.json', import.meta.url), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceOf = (id) => { const s = fixture.inputs[id]; return { rgba: new Uint8ClampedArray(Buffer.from(s.rgba, 'base64')), w: s.w, h: s.h }; };
const glyphs = { ...fixture.glyphs, masks: new Uint8Array(Buffer.from(fixture.glyphs.masks, 'base64')) };
const backdropJob = (c) => {
  const { effect, dark, page, mute, strength, ...rest } = c.job;
  return { source: sourceOf(c.input), look: effect, theme: dark ? 'dark' : 'light', page, ...rest, params: { ...rest.params, mute, strength } };
};

test('lab RGBA parity: every look, picture, theme, dissolve and pane span', () => {
  for (const c of fixture.cases) {
    const job = backdropJob(c), before = job.source.rgba.slice();
    const r = atmosphere.renderBackdrop(job);
    assert.equal(r.w, fixture.w, c.id);
    assert.equal(r.h, fixture.h, c.id);
    assert.equal(sha(r.rgba), c.sha256, c.id);
    if (c.rgba) assert.deepEqual(r.rgba, new Uint8ClampedArray(Buffer.from(c.rgba, 'base64')), c.id);
    assert.deepEqual(job.source.rgba, before, `${c.id}: source remains reusable`);
  }
});

test('lab transition and transparent ripple frames retain their exact pixels', () => {
  for (const f of fixture.frames) {
    const r = atmosphere.atmosphereTransition(f.style, f.t, { from: sourceOf('p501'), to: sourceOf('calm-sea'), page: [245, 245, 245], theme: 'light', glyphs });
    assert.equal(sha(r.rgba), f.sha256, `${f.style}/${f.t}`);
  }
  for (const f of fixture.overlays) {
    const r = atmosphere.atmosphereRipple(f.t, { w: fixture.w, h: fixture.h, page: f.dark ? [19, 17, 17] : [245, 245, 245], theme: f.dark ? 'dark' : 'light', glyphs });
    assert.equal(sha(r.rgba), f.sha256, `overlay/${f.dark}/${f.t}`);
  }
});

test('lab crop geometry places the source horizon across a virtual surface', () => {
  for (const c of fixture.crops) {
    const r = atmosphere.cropOf(c.source, c.span.W, c.span.H, c.focus, c.horizon);
    assert.deepEqual({ s: r.s, sx: r.sx, sy: r.sy, vw: r.vw, vh: r.vh, horizon: r.toBand(0.76) }, c.expected);
  }
});

test('per-picture memory keeps the release params until the effect changes and resets by deletion', () => {
  const pictures = [{ id: 'sea', look: { effect: 'fine', params: { cell: 3 }, dissolve: { style: 'gradient' }, strength: 0.8 } }, { id: 'lake', look: { effect: 'original' } }];
  const looks = { sea: { fade: 'rows', strength: 0.4 } };
  const release = atmosphere.releaseLook(pictures[0]);
  assert.equal(release.effect, 'fine');
  assert.equal(release.fade, 'gradient');
  assert.deepEqual(atmosphere.lookFor('sea', looks, pictures).params, { cell: 3 });
  assert.equal(atmosphere.lookFor('sea', looks, pictures).strength, 0.4);
  assert.equal(atmosphere.lookFor('lake', looks, pictures).strength, 1);
  assert.deepEqual(atmosphere.changedKeys('sea', looks), ['fade', 'strength']);
  looks.sea.effect = 'mosaic';
  assert.equal(atmosphere.lookFor('sea', looks, pictures).params.cell, 8);
  delete looks.sea;
  assert.deepEqual(atmosphere.changedKeys('sea', looks), []);
  const reset = atmosphere.lookFor('sea', looks, pictures);
  assert.equal(reset.effect, release.effect);
  assert.equal(reset.fade, release.fade);
  assert.equal(reset.strength, release.strength);
  assert.deepEqual(atmosphere.lookFor('sea', { sea: { effect: 'unknown' } }, pictures).params, {});
  assert.deepEqual(atmosphere.resolveParams(undefined), {});
  for (const effect of atmosphere.ATMOSPHERE_LOOKS) {
    assert.deepEqual(atmosphere.lookFor('sea', { sea: { effect: effect.id } }, [{ id: 'sea', look: { effect: 'unknown' } }]).params,
      atmosphere.resolveParams(effect));
  }
});

test('picture catalogue contains exactly the approved pool with direct source hosts', () => {
  const photos = ['white-rocks-open-sea', 'dune-grass', 'pastel-daybreak', 'snowy-alps', 'valley-lakes', 'glacier-lake', 'peak-in-the-clouds', 'orange-dune', 'balloons-at-dawn', 'ferris-wheel'];
  const paintings = ['calm-sea', 'gloucester-harbor', 'landers-peak', 'merced-river', 'ship-by-moonlight', 'the-oxbow', 'sugar-loaf-autumn', 'fontainebleau-morning', 'haystacks-morning'];
  assert.deepEqual(atmosphere.ATMOSPHERE_PICTURES.filter(p => p.kind === 'photo').map(p => p.id), photos);
  assert.deepEqual(atmosphere.ATMOSPHERE_PICTURES.filter(p => p.kind === 'painting').map(p => p.id), paintings);
  for (const p of atmosphere.ATMOSPHERE_PICTURES) {
    for (const url of Object.values(p.src)) assert.equal(new URL(url).hostname, p.id === 'orange-dune' ? 'picsum.photos' : p.kind === 'photo' ? 'images.unsplash.com' : 'images.metmuseum.org');
    assert.ok(p.credit.author);
    assert.equal(p.credit.licence, p.kind === 'photo' ? 'Unsplash License' : 'CC0 (The Met Open Access)');
  }
});

test('caller-set effect values are applied without catalogue slider clamps', () => {
  const job = { source: sourceOf('p501'), look: 'fine', page: [245, 245, 245], theme: 'light', params: { cell: 6, levels: 16 } };
  const custom = atmosphere.renderBackdrop(job);
  const sliderLimit = atmosphere.renderBackdrop({ ...job, params: { cell: 4, levels: 14 } });
  assert.notEqual(sha(custom.rgba), sha(sliderLimit.rgba));
});

test('lab ordered foot fade keeps its exact alpha lattice', () => {
  const parity = JSON.parse(readFileSync(new URL('./fixtures/ordered-fade-parity.json', import.meta.url), 'utf8'));
  const input = (width, height, seed) => {
    const out = new Uint8ClampedArray(width * height * 4);
    let s = seed;
    for (let k = 0; k < out.length; k++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; out[k] = (k & 3) === 3 && (s >>> 28) < 3 ? 0 : s >>> 24; }
    return out;
  };
  for (const c of parity.cases) {
    const rgba = input(c.width, c.height, c.seed);
    atmosphere.orderedFade(rgba, c.width, c.height, c.y0, c.y1, c.dpr);
    assert.equal(sha(rgba), c.sha256, c.id);
    if (c.rgba) assert.deepEqual(rgba, new Uint8ClampedArray(Buffer.from(c.rgba, 'base64')), c.id);
  }
});
