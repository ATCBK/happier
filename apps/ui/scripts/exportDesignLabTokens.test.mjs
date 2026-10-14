import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import { transform } from 'esbuild';
import { renderProductTokensCss } from './exportDesignLabTokens.mjs';

test('current web tokens produce usable opt-in light/dark CSS and real font faces', async () => {
  const css = await renderProductTokensCss();
  const { warnings } = await transform(css, { loader: 'css' });
  assert.deepEqual(warnings, []);
  const [light, dark] = css.split('[data-theme="dark"]');
  assert.match(light, /--product-space-s8: [\d.]+px;/);
  for (const role of [
    'display',
    'title',
    'heading',
    'label',
    'reading',
    'body',
    'meta',
    'micro',
  ]) {
    for (const metric of ['size', 'line', 'weight', 'tracking'])
      assert.match(
        light,
        new RegExp(`--product-type-${role}-${metric}: [^;]+;`),
      );
    assert.match(css, new RegExp(`\\.t-${role}\\s*\\{`));
  }
  for (const step of [2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48])
    assert.match(light, new RegExp(`--product-space-s${step}: ${step}px;`));
  assert.match(light, /--product-page-section-gap-px: [\d.]+px;/);
  for (const role of [
    'card-padding',
    'card-gap',
    'page-padding-bottom',
    'pane-header-height',
    'pane-header-under-native-chrome-height',
    'control-height',
  ]) {
    assert.match(light, new RegExp(`--product-page-${role}-px: [\\d.]+px;`));
  }
  for (const column of ['reading', 'wide'])
    assert.match(
      light,
      new RegExp(`--product-page-column-${column}: [\\d.]+px;`),
    );
  assert.match(light, /--product-border-radius-md: [\d.]+px;/);
  assert.match(light, /--product-type-label-size: [\d.]+px;/);
  assert.match(
    light,
    /--product-colors-shadow-levels-1-shadow-opacity: [\d.]+;/,
  );
  assert.match(dark, /--product-colors-glass-inner-shadow: [^;]+;/);
  const canvas = (section) =>
    section.match(/--product-colors-background-canvas: ([^;]+);/)[1];
  assert.notEqual(canvas(light), canvas(dark));
  assert.ok(
    [...css.matchAll(/(--[\w-]+):/g)].every(([, name]) =>
      name.startsWith('--product-'),
    ),
  );
  // Labs pick faces by weight like the app: in-between lab weights snap to the nearest shipped face, ties to the lighter.
  const faceFor = (face, weight) =>
    [
      ...css.matchAll(
        /@font-face \{ font-family: "([^"]+)"; src: url\("[^"]*\/([\w-]+)\.ttf"\)[^}]*font-weight: (\d+) (\d+);(?! font-style)/g,
      ),
    ].find(
      ([, family, , min, max]) =>
        family === face && weight >= Number(min) && weight <= Number(max),
    )?.[2];
  const defaultFace = light.match(/--product-type-face-default: "([^"]+)";/)[1];
  const monoFace = light.match(/--product-type-face-mono: "([^"]+)";/)[1];
  assert.deepEqual(
    [1, 400, 450, 451, 500, 550, 560, 640, 1000].map((weight) =>
      faceFor(defaultFace, weight),
    ),
    [
      'Inter-Regular',
      'Inter-Regular',
      'Inter-Regular',
      'Inter-Medium',
      'Inter-Medium',
      'Inter-Medium',
      'Inter-SemiBold',
      'Inter-SemiBold',
      'Inter-SemiBold',
    ],
  );
  assert.deepEqual(
    [400, 500, 501, 600].map((weight) => faceFor(monoFace, weight)),
    [
      'IBMPlexMono-Regular',
      'IBMPlexMono-Regular',
      'IBMPlexMono-SemiBold',
      'IBMPlexMono-SemiBold',
    ],
  );
  for (const [, path] of css.matchAll(/src: url\("([^"]+)"\)/g)) {
    await access(
      new URL(`../../../.happier/design-lab/_shared/${path}`, import.meta.url),
    );
  }
});
