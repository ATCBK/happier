// U8 harness: the product's Loading and Welcome planet moments in a real browser on the page clock, beside
// fresh lab stills (`mo-render.mjs`), plus the hand-off identity check.
// Usage (repo root): U8_CHROME=<chromium> LAB_SHOTS=<dir of fresh lab stills> node apps/ui/tools/atmosphere/planetMomentsHarness.mjs
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(ui, '../..');
const bundle = await build({
    entryPoints: [join(ui, 'sources/dev/atmosphere/PlanetMomentsHarness.tsx')], bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', write: false, tsconfig: join(ui, 'tsconfig.json'),
    resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.js', '.mjs'],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'u8-boundary', setup(build) {
        const stubs = join(ui, 'sources/dev/atmosphere/planetMomentsHarnessStubs.ts');
        build.onResolve({ filter: /^(\.\/homeAtmosphereMoments|react-native-unistyles)$/ }, () => ({ path: stubs }));
    } }],
    alias: {
        'react-native': join(ui, 'sources/dev/atmosphere/planetMomentsHarnessBoundary.ts'),
        '@/components/ui/motion/motionTokens': join(ui, 'sources/dev/atmosphere/momentHarnessMotion.ts'),
    },
});
const fonts = ['IBMPlexMono-Regular', 'IBMPlexMono-SemiBold', 'Inter-Regular', 'Inter-SemiBold']
    .map(name => `@font-face{font-family:"${name}";src:url('/apps/ui/sources/assets/fonts/${name}.ttf')}`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#888}${fonts}</style><div id="product"></div><script src="/harness.js"></script>`;
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
        if (pathname === '/harness.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); return; }
        const file = pathname.startsWith('/lab/') ? join(process.env.LAB_SHOTS, pathname.slice(5)) : resolve(repo, `.${pathname}`);
        const types = { '.js': 'text/javascript', '.ttf': 'font/ttf', '.png': 'image/png' };
        response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
        response.end(await readFile(file));
    } catch (error) { response.writeHead(404).end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const require = createRequire(join(repo, 'packages/tests/package.json'));
const { chromium } = require('playwright');
const shots = join(repo, '.project/plans/2026-10-10-home-atmosphere/lanes/U8-shots');
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.U8_CHROME });
const W = 1440, H = 940;
const report = [];
try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.clock.install({ time: 0 });
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.U8));
    await page.evaluate(async () => {
        for (const face of ['12px "IBMPlexMono-Regular"', '600 12px "IBMPlexMono-SemiBold"', '12px "Inter-Regular"', '12px "Inter-SemiBold"']) await document.fonts.load(face);
    });
    await page.clock.pauseAt(1000);
    /** Render a case and step the page clock to moment time `t` (seconds), frame by frame. */
    const still = async (kind, input, t, name) => {
        await page.evaluate(() => window.U8.clear());
        await page.evaluate(({ kind, input }) => window.U8[kind](input), { kind, input });
        let elapsed = 0;
        while (elapsed < t * 1000) { const step = Math.min(16, t * 1000 - elapsed); await page.clock.runFor(step); elapsed += step; }
        // Let the canvas paints that awaited font readiness (real promises) land before the still.
        await page.waitForTimeout(60);
        const path = join(shots, `${name}.png`);
        await page.screenshot({ path, clip: { x: 0, y: 0, width: W, height: H } });
        return path;
    };
    const READY = 2.6; // the lab's live Loading board resolves at 2.6 s
    for (const theme of ['light', 'dark']) {
        for (const t of [0.2, 0.6, 2.4, 2.75, 3.0, 3.3, 3.45, 3.7]) {
            await still('loading', { theme, width: W, height: H, placement: 'corner', readyAt: READY }, t, `live-loading-corner-${theme}-t${t}`);
        }
        for (const t of [3.3, 3.45, 3.7]) await still('loading', { theme, width: W, height: H, placement: 'rise', readyAt: READY }, t, `live-loading-rise-${theme}-t${t}`);
        for (const t of [1.0, 2.75, 3.0]) await still('loading', { theme, width: W, height: H, placement: 'corner', readyAt: READY, reducedMotion: true }, t, `live-loading-rm-${theme}-t${t}`);
        for (const t of [0.0, 0.35, 0.95, 1.35, 1.8, 1.95]) await still('welcome', { theme, width: W, height: H, placement: 'corner' }, t, `live-welcome-corner-${theme}-t${t}`);
        // Fast load: ready inside the grace, no loader at all.
        await still('loading', { theme, width: W, height: H, placement: 'corner', readyAt: 0.2 }, 0.24, `live-loading-fast-${theme}-t0.24`);
    }
    // Hand-off identity: the landed moment (held up) and Home's own planet after the hand-over are the same pixels.
    for (const placement of ['corner', 'rise']) {
        await still('loading', { theme: 'dark', width: W, height: H, placement, readyAt: READY, holdHandOff: true }, READY + 1.3, `handoff-${placement}-held`);
        const held = await page.evaluate(() => window.U8.pixels('loading-planet.travel'));
        await still('loading', { theme: 'dark', width: W, height: H, placement, readyAt: READY }, READY + 1.3, `handoff-${placement}-home`);
        const home = await page.evaluate(() => window.U8.pixels('home-planet'));
        const travelGone = await page.evaluate(() => !document.querySelector('[data-testid="loading-planet"]'));
        let differ = 0; if (held && home && held.length === home.length) for (let i = 0; i < held.length; i++) if (held[i] !== home[i]) differ++;
        report.push({ check: `handoff-${placement}`, heldBytes: held?.length ?? null, homeBytes: home?.length ?? null, differingBytes: held && home ? differ : null, momentRemoved: travelGone });
    }
    // Side by side: the lab still (left) beside the product (right), where a fresh lab still exists.
    const pairs = [];
    for (const theme of ['light', 'dark']) {
        for (const t of [2.4, 2.75, 3.0, 3.3, 3.45, 3.7]) pairs.push([`mo4-loading-D-${theme}-t${t}.png`, `live-loading-corner-${theme}-t${t}.png`, `sbs-loading-corner-${theme}-t${t}`]);
        for (const t of [3.45, 3.7]) pairs.push([`mo4-loading-R-${theme}-t${t}.png`, `live-loading-rise-${theme}-t${t}.png`, `sbs-loading-rise-${theme}-t${t}`]);
        for (const t of [0.35, 0.95, 1.35]) pairs.push([`mo4-welcome-D-${theme}-t${t}.png`, `live-welcome-corner-${theme}-t${t}.png`, `sbs-welcome-${theme}-t${t}`]);
    }
    await page.clock.resume();
    for (const [lab, live, name] of pairs) {
        if (!process.env.LAB_SHOTS || !existsSync(join(process.env.LAB_SHOTS, lab))) { report.push({ sbs: name, skipped: `no lab still ${lab}` }); continue; }
        await page.setContent(`<body style="margin:0;background:#888;display:inline-flex;gap:8px;padding:8px"><figure style="margin:0"><img src="${origin}/lab/${lab}" style="width:700px;display:block"><figcaption style="font:12px system-ui;color:#fff">lab · ${lab}</figcaption></figure><figure style="margin:0"><img src="${origin}/.project/plans/2026-10-10-home-atmosphere/lanes/U8-shots/${live}" style="width:700px;display:block"><figcaption style="font:12px system-ui;color:#fff">live · ${live}</figcaption></figure></body>`);
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
        await page.locator('body').screenshot({ path: join(shots, `${name}.png`) });
    }
    report.push({ pageErrors: [...new Set(errors)] });
} finally {
    await writeFile(join(shots, 'harness-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
    server.close();
}
