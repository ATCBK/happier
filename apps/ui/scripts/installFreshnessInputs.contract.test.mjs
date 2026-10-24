import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveUiPostinstallTasks } from '../tools/resolveUiPostinstallTasks.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('UI manifest declares every local postinstall input through the canonical install freshness owner', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const declaredInputs = packageJson?.happier?.installFreshnessInputs;
  const tasks = resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '1' } });
  const localInputsByTask = new Map([
    ['verify-patched-dependencies', []],
    ['verify-native-patch-compilation', ['app.config.js']],
    ['verify-vendored-reanimated-patch', []],
    ['verify-vendored-legend-patch', []],
    ['verify-expo-router-web-modal-patch', []],
    ['verify-sentry-native-replay-postinit-patch', []],
    ['install-react-native-enriched-markdown-web-wasm', ['tools/react-native-enriched-markdown']],
    ['verify-react-native-enriched-markdown-web-streaming-patch', ['tools/react-native-enriched-markdown']],
    ['setup-skia-web', []],
    ['vendor-monaco', []],
    ['vendor-pdfjs', ['tools/pdfjs']],
    ['vendor-pdfjs-webview-bundle', ['tools/pdfjs']],
    ['vendor-pierre-diffs-worker', ['tools/diffs']],
    ['vendor-password-kdf-worker', ['tools/password', 'tools/sourceAsset.mjs']],
    ['vendor-crypto-worker', ['tools/crypto', 'tools/sourceAsset.mjs']],
    ['prepare-atmosphere-renderers', ['tools/atmosphere/buildAtmosphereRenderers.mjs', 'tools/sourceAsset.mjs']],
    ['vendor-codemirror-webview-bundle', ['tools/codemirror']],
    ['vendor-xterm-webview-bundle', ['tools/xterm']],
    [
      'vendor-tiptap-webview-bundle',
      [
        'tools/tiptap',
      ],
    ],
    [
      'vendor-mermaid-webview-bundle',
      [
        'tools/mermaid',
      ],
    ],
  ]);

  assert.deepEqual(
    [...localInputsByTask.keys()].sort(),
    [...tasks].sort(),
    'every resolved postinstall task must declare its local source inputs in this contract',
  );

  const expectedInputs = [...new Set([
    'tools/postinstall.mjs',
    'tools/resolveUiPostinstallTasks.mjs',
    'tools/postinstall',
    ...[...localInputsByTask.values()].flat(),
  ])].sort();
  assert.ok(Array.isArray(declaredInputs));
  assert.deepEqual([...declaredInputs].sort(), expectedInputs);
  for (const relativePath of declaredInputs) {
    await assert.doesNotReject(
      () => stat(join(packageRoot, relativePath)),
      `install freshness input must exist: ${relativePath}`,
    );
  }
});
