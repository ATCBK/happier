import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { FEATURE_CATALOG } from '../../../packages/protocol/dist/features/catalog.js';
import { UI_FEATURE_REGISTRY } from '../../../packages/protocol/dist/actions/settings/featurePreferenceMutations.js';
import { collectUiToggles, renderFeatureFlagReferenceMarkdown } from './generateFeatureFlagReference.mjs';

test('reads the complete canonical feature inventory without parsing the UI re-export', async () => {
  await assert.doesNotReject(() => renderFeatureFlagReferenceMarkdown());
  const ids = Object.keys(FEATURE_CATALOG).sort();
  assert.deepEqual(Object.keys(collectUiToggles(UI_FEATURE_REGISTRY, ids)).sort(), ids);
});

test('refuses an incomplete canonical toggle inventory instead of guessing a hidden toggle', () => {
  const { voice: omitted, ...incomplete } = UI_FEATURE_REGISTRY;
  assert.ok(omitted);
  assert.throws(() => collectUiToggles(incomplete, ['voice']), { name: 'Error' });
});
