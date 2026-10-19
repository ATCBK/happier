// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { renderSurface } from './settings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let page: PluginUiTestkit | undefined;
afterEach(async () => { await page?.dispose(); page = undefined; });

it('renders the supplied explanation beside the personal-task setup choice', async () => {
  const explanation = 'Keep the existing personal task list';
  await act(async () => {
    page = await createPluginUiTestkit({
      identity: { instanceId: 'internal-task-settings', mountNonce: 'settings-render' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        translations: { 'plugins.triage.internal.existing': explanation },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  expect(await page!.queryByText(explanation)).toBeDefined();
});
