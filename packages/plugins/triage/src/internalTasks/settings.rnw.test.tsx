// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { renderSurface } from './settings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let page: PluginUiTestkit | undefined;
afterEach(async () => { await page?.dispose(); page = undefined; });

it('says why setup cannot be offered when the Account cannot be read, and offers no setup', async () => {
  const reason = 'Your sources cannot be read right now';
  await act(async () => {
    page = await createPluginUiTestkit({
      identity: { instanceId: 'internal-task-settings', mountNonce: 'settings-render' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: renderSurface,
      // No Account data client: the configured-source read cannot happen.
      surfaceContext: createSurfaceContextFixture({
        translations: { 'plugins.triage.surface.sources.unavailable': reason },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  await expect(page!.getByText('Personal tasks')).resolves.toBeDefined();
  await expect(page!.getByText(reason)).resolves.toBeDefined();
  await expect(page!.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
});
