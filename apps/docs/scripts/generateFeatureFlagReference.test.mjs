import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { FEATURE_CATALOG } from '../../../packages/protocol/dist/features/catalog.js';
import { UI_FEATURE_REGISTRY } from '../../../packages/protocol/dist/actions/settings/featurePreferenceMutations.js';
import { collectUiToggles, renderFeatureFlagReferenceMarkdown } from './generateFeatureFlagReference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

test('reads and renders the complete canonical feature inventory without parsing the UI re-export', async () => {
  const markdown = await renderFeatureFlagReferenceMarkdown();
  const ids = Object.keys(FEATURE_CATALOG).sort();
  assert.deepEqual(Object.keys(collectUiToggles(UI_FEATURE_REGISTRY, ids)).sort(), ids);
  for (const id of ids) {
    assert.ok(markdown.includes(`\`${id}\``), `missing feature ${id}`);
  }
});

test('refuses an incomplete canonical toggle inventory instead of guessing a hidden toggle', () => {
  const { voice: omitted, ...incomplete } = UI_FEATURE_REGISTRY;
  assert.ok(omitted);
  assert.throws(() => collectUiToggles(incomplete, ['voice']), { name: 'Error' });
});

test('canonical feature-reference inputs omit the retired plugin UI dev-server tier', () => {
  const protocolCatalog = readFileSync(
    join(REPO, 'packages', 'protocol', 'src', 'features', 'catalog.ts'),
    'utf8',
  );
  const uiRegistry = readFileSync(
    join(REPO, 'apps', 'ui', 'sources', 'sync', 'domains', 'features', 'registry', 'uiFeatureRegistry.ts'),
    'utf8',
  );

  assert.doesNotMatch(protocolCatalog, /plugins\.ui\.reactNativeBundles\.devHotReload/u);
  assert.doesNotMatch(uiRegistry, /plugins\.ui\.reactNativeBundles\.devHotReload/u);
});
