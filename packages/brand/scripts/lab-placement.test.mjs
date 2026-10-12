import test from 'node:test';
import assert from 'node:assert/strict';
import { homePlanetGeometry, homePlanetSceneOptions } from '../planet-placement.mjs';

// The browser global is the lab adapter's real platform boundary. Run locally: the lab is ignored.
globalThis.window = {};
await import('../../../.happier/design-lab/atmosphere/at-planet-geometry.js');
test('active lab placement and scene options delegate to the brand owner', () => {
  for (const phone of [false, true]) for (const widgets of [false, true]) {
    const pane = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    for (const place of ['corner', 'side', 'rise']) for (const limb of [undefined, 420]) {
      const options = { phone, widgets, limb };
      const actual = window.ATP.geom(place, pane.width, pane.height, options);
      const expected = homePlanetGeometry(place, pane, options);
      assert.deepEqual(actual, place === 'rise' ? { ...expected, mirror: false } : expected);
      for (const theme of ['light', 'dark']) for (const digits of [false, true]) {
        assert.deepEqual(window.ATP.sceneOptions({ ...actual, theme, digits }).field,
          homePlanetSceneOptions(expected, pane, { theme, style: 'balanced', digits }).field);
      }
    }
  }
  window.AT_TUNE = { k: 1.1, dl: 12, rot: 0.4, mir: true, ht: 0.2 };
  const tuned = window.ATP.geom('rise', 1440, 900, { limb: 420 });
  assert.equal(tuned.R, 1440 * 1.1);
  assert.equal(tuned.cy, 432 + tuned.R);
  assert.equal(tuned.rotate, 0.4);
  assert.equal(tuned.mirror, true);
  assert.equal(tuned.halo.top, 0.2);
  assert.equal(window.ATP.options('swatch', 100, 100).fullness, 0);
});
