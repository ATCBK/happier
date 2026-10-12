// U9b drawing harness: renders the product's moment painters (QR, pairing, theme switch) in a real browser,
// beside the lab's own stills, decodes held QR frames with jsQR and drives the real View Transition port.
// Usage (repo root): U9B_CHROME=<chromium path> node apps/ui/tools/atmosphere/momentHarness.mjs
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(ui, '../..');
const bundle = await build({
  entryPoints: [join(ui, 'sources/dev/atmosphere/MomentHarness.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  write: false,
  tsconfig: join(ui, 'tsconfig.json'),
  loader: { '.png': 'file' },
  assetNames: 'assets/[name]',
  publicPath: '/',
  outdir: '/tmp/u9b-harness',
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  alias: {
    'react-native': join(ui, 'sources/dev/atmosphere/canvasHarnessBoundary.ts'),
    '@/components/ui/motion/motionTokens': join(ui, 'sources/dev/atmosphere/momentHarnessMotion.ts'),
  },
});
const outputs = new Map(
  bundle.outputFiles.map((file) => [
    `/${file.path.split('/tmp/u9b-harness/')[1]}`,
    file,
  ]),
);
const fonts = [
  'IBMPlexMono-Regular',
  'IBMPlexMono-SemiBold',
  'Inter-Regular',
  'Inter-Medium',
  'Inter-SemiBold',
]
  .map(
    (name) =>
      `@font-face{font-family:"${name}";src:url('/apps/ui/sources/assets/fonts/${name}.ttf')}`,
  )
  .join('');
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#f5f5f5;font-family:"Inter-Regular"}${fonts}
::view-transition-image-pair(root){isolation:auto}::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal;display:block}
#themed{position:fixed;inset:0;display:none;padding:64px;box-sizing:border-box;font:600 40px "Inter-SemiBold";color:#1a1a1a;background:#f5f5f5}
#themed[data-theme=dark]{background:#131111;color:#efefef}#themed p{font:400 16px "Inter-Regular";opacity:.6;max-width:520px}</style>
<div id="themed" data-theme="dark">Good morning<p>The new theme rises as the limb of a huge planet; night falls from above. This page stands in for the app shell.</p></div>
<div id="product"></div><script src="/MomentHarness.js"></script>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(html);
      return;
    }
    const built = outputs.get(pathname);
    if (built) {
      response.setHeader(
        'content-type',
        pathname.endsWith('.js') ? 'text/javascript' : 'image/png',
      );
      response.end(built.contents);
      return;
    }
    const file = resolve(repo, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(repo + '/')) {
      response.writeHead(403).end();
      return;
    }
    const types = {
      '.js': 'text/javascript',
      '.ttf': 'font/ttf',
      '.png': 'image/png',
    };
    response.setHeader(
      'content-type',
      types[extname(file)] ?? 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(404).end(String(error));
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const require = createRequire(join(repo, 'packages/tests/package.json'));
const { chromium } = require('playwright');
const jsQR = createRequire(join(repo, 'package.json'))('jsqr');
const shots = join(
  repo,
  '.project/plans/2026-10-10-home-atmosphere/lanes/U9b-shots',
);
await mkdir(shots, { recursive: true });
// Fresh lab renders (the lab now draws through the brand package); the 2026-10-09 shots predate that move.
const LAB = '/.project/plans/2026-10-10-home-atmosphere/lanes/U9b-shots';
// A v2 pairing link of the product's shape and a realistic length.
const INVITE = { v: 2, intent: 'home_device', direction: 'trusted_home_displays', pairId: 'pair_7Hq2K9xN4mZpR3vD8kLwQ2tB',
  home: { v: 1, homeServerIdentityId: 'srv_01JABCDEFGHJKMNPQRSTVWXYZ', canonicalServerUrl: 'https://home.example.dev', revision: 3, endpoints: [{ kind: 'https', url: 'https://home.example.dev' }] },
  qrSecretBase64Url: Buffer.alloc(32, 3).toString('base64url'), issuedAtMs: 1791700000000, expiresAtMs: 1791700300000 };
const linkOf = (invite) => `happier:///pair?v=2&payload=${encodeURIComponent(Buffer.from(JSON.stringify(invite)).toString('base64url'))}`;
// A v2 invite of the product's real shape and length (~590 chars → version 19 at medium correction).
const LINK = linkOf(INVITE);
const LINK2 = linkOf({ ...INVITE, pairId: 'pair_R3vD8kLwQ2tB7Hq2K9xN4mZp' });
const browser = await chromium.launch({
  executablePath: process.env.U9B_CHROME,
});
const results = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.U9B));
  await page.evaluate(() => document.fonts.ready);
  const T = await page.evaluate(() => ({
    QR: window.U9B.QR,
    SCAN: window.U9B.SCAN,
    PAIR: window.U9B.PAIR,
  }));

  // 1 · held frames decode (assembled, re-formed, at the product's 240 px block and the lab's 200/216)
  for (const [label, request, expect, size] of [
    ['assemble-240', { draw: 'qr', link: LINK, t: T.QR.T }, LINK, 240],
    ['assemble-216', { draw: 'qr', link: LINK, t: T.QR.T }, LINK, 216],
    [
      'reform-240',
      {
        draw: 'reform',
        from: LINK,
        next: LINK2,
        t: T.QR.BREAK + 0.4 + T.QR.T,
        wait: 0.4,
      },
      LINK2,
      240,
    ],
  ]) {
    const pixels = await page.evaluate(
      ([request, size]) => window.U9B.heldPixels(request, size),
      [request, size],
    );
    const decoded = jsQR(
      Uint8ClampedArray.from(pixels.rgba),
      pixels.w,
      pixels.h,
    );
    assert.equal(decoded?.data, expect, `jsQR ${label}`);
    results.push(
      `jsQR ${label}: decoded (v${decoded.version}, ${pixels.w}x${pixels.h} device px)`,
    );
  }

  // the same held code at DPR 1 (whole css-px modules)
  {
    const one = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    await one.goto(origin);
    await one.waitForFunction(() => Boolean(window.U9B));
    const pixels = await one.evaluate(([request, size]) => window.U9B.heldPixels(request, size), [{ draw: 'qr', link: LINK, t: T.QR.T }, 240]);
    const decoded = jsQR(Uint8ClampedArray.from(pixels.rgba), pixels.w, pixels.h);
    assert.equal(decoded?.data, LINK, 'jsQR assemble-240 at DPR 1');
    results.push(`jsQR assemble-240 dpr1: decoded (v${decoded.version}, ${pixels.w}x${pixels.h} device px)`);
    await one.close();
  }

  // 2 · lab beside product, per board, per theme
  const qrRows = (theme) => [
    [
      [{ draw: 'making' }, 'before · making'],
      [{ draw: 'qr', link: LINK, t: 0.1 }, '0.10 s'],
      [{ draw: 'qr', link: LINK, t: 0.26 }, '0.26 s'],
      [{ draw: 'qr', link: LINK, t: 0.42 }, '0.42 s'],
      [{ draw: 'qr', link: LINK, t: 0.6 }, '0.60 s'],
      [{ draw: 'qr', link: LINK, t: 0.76 }, '0.76 s'],
      [{ draw: 'qr', link: LINK, t: T.QR.T }, '0.92 s held'],
    ],
    [
      [
        { draw: 'reform', from: LINK, next: null, t: 0.12, wait: null },
        '0.12 s expires',
      ],
      [
        { draw: 'reform', from: LINK, next: null, t: T.QR.BREAK, wait: null },
        '0.32 s digits',
      ],
      [
        { draw: 'reform', from: LINK, next: LINK2, t: 0.77, wait: 0.25 },
        '0.77 s forms',
      ],
      [
        { draw: 'reform', from: LINK, next: LINK2, t: 1.07, wait: 0.25 },
        '1.07 s eyes',
      ],
      [
        {
          draw: 'reform',
          from: LINK,
          next: LINK2,
          t: T.QR.BREAK + 0.25 + T.QR.T,
          wait: 0.25,
        },
        '1.49 s held',
      ],
    ],
    [
      [{ draw: 'scan', link: LINK, t: 0.1 }, '0.10 s fold'],
      [{ draw: 'scan', link: LINK, t: 0.28 }, '0.28 s'],
      [{ draw: 'scan', link: LINK, t: 0.46 }, '0.46 s paper gives way'],
      [{ draw: 'scan', link: LINK, t: 0.64 }, '0.64 s'],
      [{ draw: 'scan', link: LINK, t: T.SCAN.T }, '0.90 s planet'],
    ],
  ];
  const pairRow = [
    [
      { draw: 'pairing', phase: 'handoff', t: 0.12, device: 'iPhone' },
      '0.12 s settles',
    ],
    [
      { draw: 'pairing', phase: 'handoff', t: 0.32, device: 'iPhone' },
      '0.32 s horizon',
    ],
    [
      { draw: 'pairing', phase: 'handoff', t: T.PAIR.HAND, device: 'iPhone' },
      'pending (still)',
    ],
    [
      { draw: 'pairing', phase: 'joined', t: 0.2, device: 'iPhone' },
      '0.20 s trace',
    ],
    [
      { draw: 'pairing', phase: 'joined', t: 0.42, device: 'iPhone' },
      '0.42 s ignites',
    ],
    [
      { draw: 'pairing', phase: 'joined', t: 0.62, device: 'iPhone' },
      '0.62 s digits',
    ],
    [
      { draw: 'pairing', phase: 'joined', t: T.PAIR.T, device: 'iPhone' },
      'rest',
    ],
  ];
  for (const theme of ['light', 'dark']) {
    const card = theme === 'dark' ? '#1b1919' : '#ffffff';
    await page.evaluate(() => window.U9B.clear());
    // lab board (2× shot) rows, shown at css scale 0.5, then the product rows
    await page.evaluate(
      ([src]) => window.U9B.image(src, { x: 0, y: 380, w: 2880, h: 2700 }, 0.5),
      [`${LAB}/lab-current-mo-qr-A-${theme}.png`],
    );
    for (const row of qrRows(theme))
      await page.evaluate(
        ([row, theme, card]) => window.U9B.strip(row, theme, 200, card),
        [row, theme, card],
      );
    await page.setViewportSize({ width: 1440, height: 2400 });
    await page.screenshot({
      path: join(shots, `qr-lab-vs-live-${theme}.png`),
      fullPage: true,
    });
    await page.evaluate(() => window.U9B.clear());
    await page.evaluate(
      ([src]) => window.U9B.image(src, { x: 0, y: 380, w: 2880, h: 1300 }, 0.5),
      [`${LAB}/lab-current-mo-pair-A-${theme}.png`],
    );
    await page.evaluate(
      ([row, theme, card]) =>
        window.U9B.strip(row, theme, 216, card, ['MacBook Pro', 'devbox']),
      [pairRow, theme, card],
    );
    await page.screenshot({
      path: join(shots, `pair-lab-vs-live-${theme}.png`),
      fullPage: true,
    });
    // the product block at its real 240 px, held and pairing rest, at 100 %
    await page.evaluate(() => window.U9B.clear());
    await page.evaluate(
      ([LINK, T, theme, card]) =>
        window.U9B.strip(
          [
            [{ draw: 'qr', link: LINK, t: T.QR.T }, 'held · 240 px'],
            [
              {
                draw: 'pairing',
                phase: 'joined',
                t: T.PAIR.T,
                device: 'iPhone',
              },
              'joined · 240 px',
            ],
          ],
          theme,
          240,
          card,
          ['MacBook Pro', 'devbox'],
        ),
      [LINK, T, theme, card],
    );
    await page.screenshot({
      path: join(shots, `qr-block-240-${theme}.png`),
      clip: { x: 0, y: 0, width: 620, height: 330 },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // 3 · the real web theme switch: a View Transition with the Horizon clip and the digit overlay, frozen at lab times
  await page.evaluate(() => {
    window.U9B.clear();
    document.getElementById('themed').style.display = 'block';
  });
  for (const [to, times] of [
    ['light', [0.25, 0.5, 0.75, 0.98]],
    ['dark', [0.3, 0.55, 0.85]],
  ]) {
    for (const t of times) {
      await page.evaluate((to) => {
        document.getElementById('themed').dataset.theme =
          to === 'light' ? 'dark' : 'light';
      }, to);
      await page.waitForTimeout(100);
      await page.evaluate((to) => {
        void window.U9B.themeSwitch(to);
      }, to);
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .some(
            (a) => a.effect?.pseudoElement === '::view-transition-new(root)',
          ),
      );
      await page.evaluate((t) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = t * 1000;
        }
      }, t);
      await page.waitForTimeout(250);
      results.push(`theme ${to} t=${t}: ` + (await page.evaluate(() => JSON.stringify(document.getAnimations().map((a) => ({ pseudo: a.effect?.pseudoElement, time: a.currentTime, state: a.playState }))) + ' ' + getComputedStyle(document.documentElement, '::view-transition-new(root)').clipPath)));
      await page.screenshot({
        path: join(
          shots,
          `theme-live-${to === 'light' ? 'sunrise' : 'night'}-t${t}.png`,
        ),
      });
      await page.evaluate(() => {
        for (const a of document.getAnimations()) a.finish();
      });
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(300);
  const lingering = await page.evaluate(() => document.getAnimations().length);
  results.push(`animations left after the switches: ${lingering}`);
  assert.equal(lingering, 0, 'finished reveals are released');
  const overlays = await page.evaluate(
    () => document.querySelectorAll('canvas[aria-hidden]').length,
  );
  results.push(`theme overlays left after finishing: ${overlays}`);
  assert.equal(
    overlays,
    0,
    'the Horizon overlay is removed when the transition finishes',
  );
  assert.deepEqual(errors, [], 'page errors');
  results.push('page errors: 0');
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
