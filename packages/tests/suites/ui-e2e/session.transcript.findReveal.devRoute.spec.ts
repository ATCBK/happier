import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

/**
 * Chat Find reveal, in a real browser, through the real RN-web transcript: Find model, reveal,
 * jump host, web driver and the Legend recycler (`/dev/transcript-find` mounts `ChatList` over a
 * local history; only history timing is scripted). Each case asserts the outcome a reader sees:
 * the current mark lands below the Find capsule (and its note) and inside the viewport, and it
 * is still there after the transcript settles.
 */
type Geometry = Readonly<{
  status: string;
  markTop: number | null;
  markBottom: number | null;
  clearance: number;
  viewportBottom: number;
}>;

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (testId: string) =>
      document
        .querySelector(`[data-testid="${testId}"]`)
        ?.getBoundingClientRect() ?? null;
    const mark =
      [...document.querySelectorAll('[data-testid="find-match-current"]')]
        .map((node) => node.getBoundingClientRect())
        .find((box) => box.width > 0 && box.height > 0) ?? null;
    const item = document.querySelector('[data-testid^="transcript-item-"]');
    let scroller: Element | null = item;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    return {
      status:
        document.querySelector('[data-testid="transcript-find.status"]')
          ?.textContent ?? '',
      markTop: mark ? Math.round(mark.top) : null,
      markBottom: mark ? Math.round(mark.bottom) : null,
      clearance: Math.round(
        Math.max(
          rect('transcript-find')?.bottom ?? 0,
          rect('transcript-find.note')?.bottom ?? 0,
        ),
      ),
      viewportBottom: Math.round(
        scroller?.getBoundingClientRect().bottom ?? window.innerHeight,
      ),
    };
  });
}

/** Waits until the landing stops moving, then proves it stays put while the transcript settles. */
async function expectRevealed(page: Page, status: RegExp) {
  await expect
    .poll(async () => (await readGeometry(page)).status, { timeout: 30_000 })
    .toMatch(status);
  let previous = '';
  await expect
    .poll(
      async () => {
        const next = JSON.stringify(await readGeometry(page));
        const stable = next === previous;
        previous = next;
        return stable;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
  const landed = await readGeometry(page);
  expect(landed.markTop, JSON.stringify(landed)).not.toBeNull();
  expect(landed.markTop!).toBeGreaterThanOrEqual(landed.clearance);
  expect(landed.markBottom!).toBeLessThanOrEqual(landed.viewportBottom);
  await page.waitForTimeout(3_000);
  expect(await readGeometry(page)).toEqual(landed);
}

async function openFixture(page: Page, uiBaseUrl: string, query: string) {
  await gotoDomContentLoadedWithPathFallback(
    page,
    `${uiBaseUrl}/dev/transcript-find?happier_hmr=0${query}`,
    '/dev/transcript-find',
    120_000,
  );
  await expect(page.getByTestId('dev-transcript-find-reveal')).toBeVisible();
  // The newest row paints first, even before a late hydration.
  await expect(tailRow(page)).toBeVisible();
}

/** The closing assistant row; it never matches a query, so focusing it never selects anything. */
function tailRow(page: Page) {
  return page.locator('[data-testid^="transcript-item-"]').filter({ hasText: 'That is the whole change' }).first();
}

async function find(page: Page, text: string) {
  // Find belongs to the focused transcript: focus it, then use the shortcut a reader uses.
  await tailRow(page).click();
  await page.keyboard.press('Control+f');
  const input = page.getByTestId('transcript-find.input');
  await expect(input).toBeVisible();
  await input.fill(text);
}

test.describe('ui e2e: chat Find reveal in the real transcript', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('transcript-find-reveal-suite');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-transcript-find-reveal-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: { ...uiWebEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(360_000);
    if (!uiBaseUrl) throw new Error('missing UI fixture');
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithPathFallback(
      page,
      `${uiBaseUrl}/?happier_hmr=0`,
      '/',
      120_000,
    );
    await createAccountAndReachConnectMachineState({ page });
  });

  test('1: reveals an off-window first match from the tail with complete coverage', async ({
    page,
  }) => {
    await openFixture(page, uiBaseUrl!, '');
    await find(page, 'remount');
    await expectRevealed(page, /^1\b/);
  });

  test('2: lands the first match below the older-history note', async ({
    page,
  }) => {
    await openFixture(page, uiBaseUrl!, '&older=1&olderDelayMs=600000');
    await find(page, 'remount');
    await expect(page.getByTestId('transcript-find.note')).toBeVisible();
    await expectRevealed(page, /^1\b/);
  });

  test('3: places the match deep inside a card taller than the viewport below the capsule', async ({
    page,
  }) => {
    await openFixture(page, uiBaseUrl!, '');
    await find(page, 'must not remount the modal');
    await expectRevealed(page, /^1\b/);
    // The first two matches are the short search card; step into the tall diff card.
    for (let step = 0; step < 3; step += 1)
      await page.getByTestId('transcript-find.next').click();
    await expectRevealed(page, /^4\b/);
  });

  test('4: reveals the first match of a query entered before the transcript hydrated', async ({
    page,
  }) => {
    await openFixture(page, uiBaseUrl!, '&hydrateAfterMs=6000');
    await find(page, 'remount');
    await expectRevealed(page, /^1\b/);
  });

  test('5: reveals a match that only an older-history load brings in', async ({
    page,
  }) => {
    await openFixture(page, uiBaseUrl!, '&older=1&olderDelayMs=1500');
    await find(page, 'archived needle');
    await page.getByTestId('transcript-find-search-older').click();
    await expectRevealed(page, /^1\b/);
  });
});
