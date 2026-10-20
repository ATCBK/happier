import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: prompts registries route', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('prompts-registries-route-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW: 'prompts.library',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders the prompt registries settings screen', async ({ page }) => {
    test.setTimeout(240_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await createAccountAndReachConnectMachineState({ page });

    await page.goto(`${uiBaseUrl}/settings/prompts/registries`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('promptRegistries.addGitSource')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('promptRegistries.addGitSource').click();
    await expect(page.getByTestId('promptRegistries.sourceTitle')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('promptRegistries.sourceUrl')).toHaveCount(1, { timeout: 60_000 });
  });

  for (const width of [390, 1440]) {
    test(`returns from prompt sections to their parent at ${width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      if (!uiBaseUrl) throw new Error('missing ui base url');
      const diagnostics = collectBrowserDiagnostics({ page });
      const back = width === 390
        ? page.getByTestId('desktop-route-header-content').filter({ visible: true })
          .getByRole('button', { name: 'Back', exact: true })
        : page.getByTestId('settings-modal-back').filter({ visible: true });
      try {
        await page.setViewportSize({ width, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await createAccountAndReachConnectMachineState({ page });
        await page.goto(`${uiBaseUrl}/settings/prompts?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
        // Wide collection pages use the adjacent settings rail; phone pages have header Back.
        const sections = width === 390
          ? ['library-prompts', 'templates', 'folders', 'stacks']
          : ['folders', 'stacks'];
        for (const section of sections) {
          await page.getByTestId(`settings-prompts-${section}`).click();
          await expect(page.getByTestId('debug-router-pathname')).not.toHaveText('/settings/prompts');
          await back.click();
          await expect(page.getByTestId('debug-router-pathname')).toHaveText('/settings/prompts');
          await expect(page.getByTestId('settings-prompts-library-prompts')).toBeVisible();
        }
        await page.getByTestId('settings-prompts-stacks').click();
        await page.getByTestId('promptStacks.voice').click();
        await back.click();
        await expect(page.getByTestId('debug-router-pathname')).toHaveText('/settings/prompts/stacks/coding');
        await back.click();
        await expect(page.getByTestId('debug-router-pathname')).toHaveText('/settings/prompts');
      } catch (error) {
        throw appendBrowserDiagnostics(error, diagnostics());
      }
    });
  }
});
