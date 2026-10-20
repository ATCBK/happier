import { chromium, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';

/**
 * DESIGN-13 RUN: the lab's "Prepare the 0.3 release" Run (`run-A_*`, `hold-H*`, `inbox-I*`,
 * `phone-P*`) composed by the real Run, Inbox and column owners, captured whole at the lab,
 * wide and phone widths for the page-level pairs. Capture-only; behaviour has its own tests.
 */
let script: string;
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
const boundaries = {
  entryFile: 'sources/dev/testkit/render/workflowRunBrowserApp.tsx',
  lazy: false,
  boundaryFiles: {
    'sources/modal/index.ts':
      'sources/dev/testkit/render/workflowRunBrowserModalBoundary.ts',
    'sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.ts':
      'sources/dev/testkit/render/workflowRunBrowserMachineRpcBoundary.ts',
  },
  boundaryModules: {
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc':
      'sources/dev/testkit/render/workflowRunBrowserMachineRpcBoundary.ts',
    '@/sync/domains/state/browserRecordStorage':
      'sources/dev/testkit/render/workflowRunBrowserRecordBoundary.ts',
  },
};
const capture = process.env.RUN_DESIGN13_CAPTURE_DIR;
beforeAll(async () => {
  if (!capture) return;
  script = await buildWorkspaceHistoryBrowser(boundaries);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Run design harness did not bind');
  origin = `http://127.0.0.1:${address.port}`;
}, 2_400_000);
afterAll(async () => {
  try {
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
  } finally {
    script = '';
  }
});

type Scene = 'release' | 'release-failed' | 'release-review' | 'release-usage-limit';
type App = {
  ready: () => boolean;
  open: (href: string) => void;
  runHref: string;
  holdId: string;
  reviewId: string;
  setCompleted: () => void;
  settleStart: (refused?: boolean, errorCode?: string) => void;
  setRunState: (state: string) => void;
};
type Harness = {
  runHarness: { mount: (...args: unknown[]) => Promise<App> };
  app: App;
};

async function mount(
  page: Page,
  phone: boolean,
  theme: 'light' | 'dark',
  scene: Scene,
  href: 'run' | '/inbox' | '/workflows/runs' = 'run',
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.addScriptTag({ url: `${origin}/bundle.js` });
  await page.evaluate(
    async ({ phone, theme, scene }) => {
      const h = window as unknown as Harness;
      h.app = await h.runHarness.mount(
        phone,
        theme,
        scene === 'release-failed' || scene === 'release-usage-limit' ? 'failed' : 'running',
        false,
        false,
        true,
        false,
        scene,
      );
    },
    { phone, theme, scene },
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Harness).app.ready()))
    .toBe(true);
  await page.evaluate((target) => {
    const h = window as unknown as Harness;
    h.app.open(target === 'run' ? h.app.runHref : target);
  }, href);
  try {
    if (href === 'run')
      await page.getByTestId('workflow-run-outcome').waitFor();
    else await page.waitForTimeout(1500);
  } catch (error) {
    throw new Error(
      `${scene} did not render: ${String(error)}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`,
    );
  }
  await page.waitForTimeout(800);
  return errors;
}

/** The anchors the page verdict measures: frame, type roles and rhythm. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
      };
    };
    const ids = [
      'workflow-run-header',
      'workflow-run-outcome-region',
      'workflow-run-outcome',
      'workflow-run-needs-you',
      'workflow-run-view:flow',
      'workflow-run-steps',
      'workflow-run-technical',
      'workflow-run-pause',
      'workflow-run-cancel',
    ];
    return {
      viewport: window.innerWidth,
      ...Object.fromEntries(
        ids.map((id) => [id, read(`[data-testid="${id}"]`)]),
      ),
      title: read('[data-testid="workflow-run-header"] [role="heading"]'),
    };
  });
}

describe('DESIGN-13 RUN captures', () => {
  it.runIf(Boolean(capture))(
    'captures the release Run, hold, steps, terminal states, Inbox and phone',
    async () => {
      const repositoryRoot = fileURLToPath(
        new URL('../../../../../../', import.meta.url),
      );
      const directory = resolve(repositoryRoot, capture!);
      const phase = process.env.RUN_DESIGN13_PHASE ?? 'source';
      await mkdir(directory, { recursive: true });
      const browser = await chromium.launch({
        executablePath: resolveChromiumExecutable(),
      });
      const measurements: Record<string, unknown> = {};
      const failures: string[] = [];
      const shot = async (page: Page, name: string) => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const png = await page.screenshot({
          path: join(directory, `${phase}-${name}.png`),
        });
        // A remote worker's files do not sync back; the caller decodes these lines locally.
        process.stdout.write(`IMG ${phase}-${name}.png ${png.toString('base64')}\n`);
        measurements[name] = await measure(page);
      };
      const only = (process.env.RUN_DESIGN13_ONLY ?? '').split(',').filter(Boolean);
      const attempt = async (name: string, body: () => Promise<void>) => {
        if (only.length > 0 && !only.some((prefix) => name.startsWith(prefix))) return;
        try {
          await body();
        } catch (error) {
          failures.push(`${name}: ${String(error).slice(0, 600)}`);
        }
      };
      try {
        for (const theme of ['light', 'dark'] as const) {
          for (const [width, height] of [
            [1440, 1000],
            [1440, 1500],
            [1920, 1200],
          ] as const) {
            if (width === 1920 && theme === 'dark') continue;
            await attempt(`desk-${width}x${height}-${theme}`, async () => {
              const page = await browser.newPage({
                viewport: { width, height },
              });
              try {
                await mount(page, false, theme, 'release');
                await shot(page, `run-${width}x${height}-${theme}-map`);
                await page.getByTestId('workflow-run-view:steps').click();
                await page.waitForTimeout(500);
                await shot(page, `run-${width}x${height}-${theme}-steps`);
                await page
                  .getByTestId('workflow-run-view:activity')
                  .click();
                await page.waitForTimeout(500);
                await shot(page, `run-${width}x${height}-${theme}-activity`);
                await page.getByTestId('workflow-run-view:flow').click();
                const holdId = await page.evaluate(
                  () => (window as unknown as Harness).app.holdId,
                );
                await page
                  .getByTestId(`workflow-run-needs-you-${holdId}`)
                  .click();
                await page.waitForTimeout(1200);
                await shot(page, `hold-${width}x${height}-${theme}`);
              } finally {
                await page.close();
              }
            });
          }
          await attempt(`failed-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 1440, height: 1000 },
            });
            try {
              await mount(page, false, theme, 'release-failed');
              await shot(page, `failed-1440-${theme}`);
            } finally {
              await page.close();
            }
          });
          for (const phone of [false, true]) {
            await attempt(`usage-limit-${phone ? '390' : '1440'}-${theme}`, async () => {
              const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: phone ? 844 : 1000 } });
              try {
                await mount(page, phone, theme, 'release-usage-limit');
                await expect.poll(() => page.getByTestId('workflow-run-failure-reason').textContent()).toContain('Usage limit reached');
                await shot(page, `usage-limit-${phone ? '390' : '1440'}-${theme}`);
                await page.getByText('Publish summary', { exact: true }).first().click();
                await expect.poll(() => page.getByTestId('workflow-run-recovery-cause').textContent()).toContain('Usage limit reached');
                await expect.poll(() => page.getByTestId('workflow-run-runtime-issue-reset').isVisible()).toBe(true);
                await shot(page, `usage-limit-pane-${phone ? '390' : '1440'}-${theme}`);
              } finally { await page.close(); }
            });
          }
          // DESIGN-17 R1: the failed step selected, its recovery card leading the pane, whole page.
          for (const [width, height] of [[1440, 1000], [1600, 1000]] as const) {
            await attempt(`failedpane-${width}-${theme}`, async () => {
              const page = await browser.newPage({ viewport: { width, height } });
              try {
                await mount(page, false, theme, 'release-failed');
                await page.getByText('Publish summary', { exact: true }).first().click();
                await page.waitForTimeout(2500);
                await shot(page, `failed-pane-${width}-${theme}`);
              } finally {
                await page.close();
              }
            });
          }
          await attempt(`failedpane-390-${theme}`, async () => {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            try {
              await mount(page, true, theme, 'release-failed');
              await page.getByText('Publish summary', { exact: true }).first().click();
              await page.waitForTimeout(2500);
              await shot(page, `failed-pane-390-${theme}`);
            } finally {
              await page.close();
            }
          });
          await attempt(`completed-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 1440, height: 1000 },
            });
            try {
              await mount(page, false, theme, 'release');
              await page.evaluate(() =>
                (window as unknown as Harness).app.setCompleted(),
              );
              await page.waitForTimeout(2500);
              await shot(page, `completed-1440-${theme}`);
            } finally {
              await page.close();
            }
          });
          for (const phone of [false, true]) {
            if (phone && theme === 'dark') continue;
            const frame = phone ? 'phone' : '1440';
            await attempt(`rerun-${frame}-${theme}`, async () => {
              const page = await browser.newPage(
                phone
                  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
                  : { viewport: { width: 1440, height: 1000 } },
              );
              try {
                await mount(page, phone, theme, 'release');
                await page.evaluate(() =>
                  (window as unknown as Harness).app.setCompleted(),
                );
                await page.waitForTimeout(2500);
                if (phone)
                  await page.getByTestId('page-header-actions.trigger').click();
                await page.getByTestId('workflow-run-run-again').click();
                await page.getByTestId('workflow-run-inputs-run').waitFor();
                await page.waitForTimeout(600);
                await shot(page, `rerun-composer-${frame}-${theme}`);
                await page.getByTestId('workflow-run-inputs-run').click();
                await page.getByTestId('workflow-run-inputs-starting').waitFor();
                await shot(page, `rerun-starting-${frame}-${theme}`);
                await page.getByTestId('modal-card-close').click();
                await page.getByTestId('workflow-run-again-pending').waitFor();
                await page.waitForTimeout(400);
                await shot(page, `rerun-dismissed-${frame}-${theme}`);
                await page.evaluate(() =>
                  (window as unknown as Harness).app.settleStart(true),
                );
                await page.getByTestId('workflow-run-again-refused').waitFor();
                await page.waitForTimeout(400);
                await shot(page, `rerun-refused-${frame}-${theme}`);
                await page.getByTestId('workflow-run-run-again').click();
                await page.getByTestId('workflow-run-inputs-run').waitFor();
                await page.getByTestId('workflow-run-inputs-run').click();
                await page.getByTestId('workflow-run-inputs-starting').waitFor();
                await page.evaluate(() =>
                  (window as unknown as Harness).app.settleStart(true, 'target_unavailable'),
                );
                await page.waitForTimeout(800);
                await shot(page, `rerun-target-unavailable-${frame}-${theme}`);
              } finally {
                await page.close();
              }
            });
          }
          for (const phone of [false, true]) {
            if (phone && theme === 'dark') continue;
            const frame = phone ? 'phone' : '1440';
            await attempt(`review-${frame}-${theme}`, async () => {
              const page = await browser.newPage(
                phone
                  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
                  : { viewport: { width: 1440, height: 1000 } },
              );
              try {
                await mount(page, phone, theme, 'release-review');
                const reviewId = await page.evaluate(
                  () => (window as unknown as Harness).app.reviewId,
                );
                await page
                  .getByTestId(`workflow-run-needs-you-${reviewId}`)
                  .click();
                await page.waitForTimeout(1500);
                await shot(page, `review-${frame}-${theme}`);
              } finally {
                await page.close();
              }
            });
          }
          await attempt(`interrupted-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 1440, height: 1000 },
            });
            try {
              await mount(page, false, theme, 'release');
              await page.evaluate(() =>
                (window as unknown as Harness).app.setRunState('interrupted'),
              );
              await page.waitForTimeout(2500);
              await shot(page, `interrupted-1440-${theme}`);
            } finally {
              await page.close();
            }
          });
          await attempt(`runs-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 1440, height: 1000 },
            });
            try {
              await mount(page, false, theme, 'release', '/workflows/runs');
              await shot(page, `runs-1440-${theme}`);
            } finally {
              await page.close();
            }
          });
          await attempt(`inbox-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 1440, height: 1000 },
            });
            try {
              await mount(page, false, theme, 'release', '/inbox');
              await shot(page, `inbox-1440-${theme}`);
            } finally {
              await page.close();
            }
          });
          await attempt(`phone-${theme}`, async () => {
            const page = await browser.newPage({
              viewport: { width: 390, height: 844 },
              deviceScaleFactor: 2,
            });
            try {
              await mount(page, true, theme, 'release');
              await shot(page, `phone-run-${theme}`);
              await page.getByTestId('workflow-run-view:steps').click();
              await page.waitForTimeout(500);
              await shot(page, `phone-steps-${theme}`);
              await page.getByTestId('workflow-run-view:flow').click();
              const holdId = await page.evaluate(
                () => (window as unknown as Harness).app.holdId,
              );
              await page
                .getByTestId(`workflow-run-needs-you-${holdId}`)
                .click();
              await page.waitForTimeout(1500);
              await shot(page, `phone-hold-${theme}`);
            } finally {
              await page.close();
            }
          });
        }
      } finally {
        await browser.close();
        await writeFile(
          join(directory, `${phase}-measurements.json`),
          JSON.stringify({ measurements, failures }, null, 1),
        );
        process.stdout.write(`MEASURES ${JSON.stringify({ measurements, failures })}\n`);
      }
      expect(failures).toEqual([]);
    },
    1_800_000,
  );
});
