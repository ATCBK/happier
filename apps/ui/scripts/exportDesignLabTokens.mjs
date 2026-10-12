import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = fileURLToPath(new URL('../../../.happier/design-lab/_shared/product-tokens.css', import.meta.url));

export async function renderProductTokensCss() {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { lightTheme, darkTheme } from './sources/theme/index.ts';
        export { FontFamilies, FontWeights, Typography } from './sources/constants/Typography.ts';
        export { HAPPIER_TYPE_SCALE, HAPPIER_TYPE_WEIGHT } from '../../packages/plugin-ui/src/presentation/text/typeScale.ts';
        export { HAPPIER_PAGE_METRICS } from '../../packages/plugin-ui/src/presentation/layout/pageMetrics.ts';
      `,
      resolveDir: uiRoot,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    conditions: ['happier-source'],
    // Plain HTML labs use the real web Platform, without loading native UI code.
    plugins: [{
      name: 'web-platform',
      setup(builder) {
        builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'platform', namespace: 'lab-platform' }));
        builder.onLoad({ filter: /.*/, namespace: 'lab-platform' }, () => ({
          contents: 'export { default as Platform } from "react-native-web/dist/exports/Platform/index.js";',
          resolveDir: uiRoot,
        }));
      },
    }],
  });
  const { lightTheme, darkTheme, FontFamilies, FontWeights, Typography, HAPPIER_TYPE_SCALE, HAPPIER_TYPE_WEIGHT, HAPPIER_PAGE_METRICS } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  );
  const typography = Object.fromEntries(Object.entries(Typography)
    .filter(([name, value]) => name !== 'variant' && typeof value === 'function')
    .map(([name, style]) => [name, style()]));
  const type = Object.fromEntries(Object.entries(HAPPIER_TYPE_SCALE).map(([role, step]) => [role, {
    size: `${step.fontSize}px`, line: `${step.lineHeight}px`, weight: HAPPIER_TYPE_WEIGHT[step.weight], tracking: `${step.letterSpacing}px`,
    family: Typography.variant(role).fontFamily,
  }]));
  const page = Object.fromEntries(Object.entries({ ...HAPPIER_PAGE_METRICS, column: HAPPIER_PAGE_METRICS.columnMaxWidthPx }).map(([key, value]) => [key, typeof value === 'number' ? `${value}px` : Object.fromEntries(Object.entries(value).map(([name, px]) => [name, `${px}px`]))]));
  const kebab = value => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const declarations = (value, path = []) => {
    if (value == null || typeof value === 'boolean') return [];
    if (Array.isArray(value) && path.at(-1) === 'fontVariant') value = value.join(' ');
    if (typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) => declarations(child, [...path, key]));
    }
    if (typeof value !== 'string' && typeof value !== 'number') return [];
    const key = path.at(-1);
    // RN dimensions are CSS pixels; opacity, elevation and gradient coordinates remain unitless.
    if (typeof value === 'number' && (
      ['margins', 'space', 'borderRadius', 'iconSize'].includes(path[0]) ||
      ['radius', 'width', 'height', 'shadowRadius', 'fontSize', 'lineHeight', 'letterSpacing', 'messageGap'].includes(key)
    )) value = `${value}px`;
    if (typeof value === 'string' && (path[0] === 'fontFamilies' || key === 'fontFamily') && !value.startsWith('var(')) {
      value = JSON.stringify(value);
    }
    return [`  --product-${path.map(kebab).join('-')}: ${value};`];
  };
  const block = (selector, tokens) => `${selector} {\n${declarations(tokens).join('\n')}\n}\n`;
  const families = [...new Set(['default', 'mono', 'logo'].flatMap(kind => Object.values(FontFamilies[kind])))];
  const faces = families.map(family => {
    const fontPath = `../../../apps/ui/sources/assets/fonts/${family}.ttf`;
    const weight = family.endsWith('-SemiBold') ? HAPPIER_TYPE_WEIGHT.semiBold : family.endsWith('-Medium') ? HAPPIER_TYPE_WEIGHT.medium : family.endsWith('-Bold') ? '700' : HAPPIER_TYPE_WEIGHT.regular;
    return `@font-face { font-family: ${JSON.stringify(family)}; src: url(${JSON.stringify(fontPath)}) format("truetype"); font-weight: ${weight};${family.endsWith('-Italic') ? ' font-style: italic;' : ''} font-display: swap; }`;
  }).join('\n');
  // Labs pick a face by weight, as the app does: an in-between weight snaps to the nearest shipped face, ties to the
  // lighter (DESIGN.md → Typography). One family per kind, each shipped face covering its weight range.
  const typeFace = { default: 'Happier Interface', mono: 'Happier Mono' };
  const fontUrl = family => JSON.stringify(`../../../apps/ui/sources/assets/fonts/${family}.ttf`);
  const composedFaces = Object.entries(typeFace).flatMap(([kind, name]) => {
    const upright = [...new Map(Object.entries(FontFamilies[kind])
      .filter(([weight]) => weight !== 'italic')
      .map(([weight, family]) => [family, Number(FontWeights[weight])])).entries()]
      .sort((a, b) => a[1] - b[1]);
    const ranges = upright.map(([family, weight], index) => [family,
      index === 0 ? 1 : Math.floor((upright[index - 1][1] + weight) / 2) + 1,
      index === upright.length - 1 ? 1000 : Math.floor((weight + upright[index + 1][1]) / 2)]);
    return [
      ...ranges.map(([family, min, max]) => `@font-face { font-family: ${JSON.stringify(name)}; src: url(${fontUrl(family)}) format("truetype"); font-weight: ${min} ${max}; font-display: swap; }`),
      `@font-face { font-family: ${JSON.stringify(name)}; src: url(${fontUrl(FontFamilies[kind].italic)}) format("truetype"); font-weight: 1 1000; font-style: italic; font-display: swap; }`,
    ];
  }).join('\n');
  const utilities = Object.keys(type).map(role => `.t-${role} { font-size: var(--product-type-${role}-size); line-height: var(--product-type-${role}-line); font-family: var(--product-type-${role}-family); font-weight: var(--product-type-${role}-weight); letter-spacing: var(--product-type-${role}-tracking); }`).join('\n');
  return `/* Generated from the current app's web theme and Typography.ts.\n * Run: node apps/ui/scripts/exportDesignLabTokens.mjs\n * The shared lab kit reads its type, spacing and frames from these; feature labs follow when next touched. */\n\n${faces}\n${composedFaces}\n\n` +
    block(':root, [data-theme="light"]', { ...lightTheme, type, typeFace: Object.fromEntries(Object.entries(typeFace).map(([kind, name]) => [kind, JSON.stringify(name)])), page, fontFamilies: FontFamilies, fontWeights: FontWeights, typography: { ...lightTheme.typography, ...typography } }) + '\n' +
    block('[data-theme="dark"]', darkTheme) + '\n' + utilities + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const css = await renderProductTokensCss();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, css);
  console.log(`Generated ${outputPath}`);
}
