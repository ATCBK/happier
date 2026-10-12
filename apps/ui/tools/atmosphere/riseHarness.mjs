// FX6 Rise foot-fade harness: Home's Rise planet through the product painter, with the hero past the fold,
// drawn at the pane height (before) and at its drawn height (after).
// Usage (repo root): FX6_CHROME=<chromium path> node apps/ui/tools/atmosphere/riseHarness.mjs
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(ui, '../..');

const shots = join(repo, '.project/plans/2026-10-10-home-atmosphere/lanes/FX6-shots');
const bundle = await build({ entryPoints: [join(ui, 'sources/dev/atmosphere/RiseHarness.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  tsconfig: join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  alias: { 'react-native': join(ui, 'sources/dev/atmosphere/canvasHarnessBoundary.ts') } });
const fonts = ['IBMPlexMono-Regular', 'IBMPlexMono-SemiBold'].map((n) => `@font-face{font-family:"${n}";src:url('/apps/ui/sources/assets/fonts/${n}.ttf')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}${fonts}#product{display:inline-block}</style><div id="product"></div><script src="/harness.js"></script>`;
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (p === '/harness.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
    const file = resolve(repo, `.${decodeURIComponent(p)}`);
    if (!file.startsWith(repo + '/')) { res.writeHead(403).end(); return; }
    res.setHeader('content-type', { '.ttf': 'font/ttf', '.js': 'text/javascript' }[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch (e) { res.writeHead(404).end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { chromium } = createRequire(join(repo, 'packages/tests/package.json'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.FX6_CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => Boolean(window.FX6));
  const hero = { composerTop: 330, aboveBottom: 560, nextTop: 1010 };
  for (const theme of ['light', 'dark']) for (const drawn of [false, true]) {
    await page.evaluate((input) => window.FX6.rise(input), { ...hero, theme, drawn });
    await page.waitForTimeout(300);
    const path = join(shots, `rise-tall-${theme}-${drawn ? 'after' : 'before'}.png`);
    await page.locator('#product').screenshot({ path });
    console.log(path);
  }
  console.log('errors', JSON.stringify(errors));
} finally { await browser.close(); server.close(); }
