import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderPluginActionReferenceMarkdown } from './generatePluginActionReference.mjs';
import { GENERATORS } from './generateReference.mjs';

test('the docs generator registry owns the published Plugin host Action reference', () => {
  const expectedOutput = fileURLToPath(
    new URL('../content/docs/plugins/api/host-actions.mdx', import.meta.url),
  );

  assert.equal(
    GENERATORS.filter((generator) => generator.outputPath === expectedOutput).length,
    1,
    'host-actions.mdx must have exactly one registered docs generator',
  );
});

test('the Action reference prepares the canonical built Protocol owner before loading it', async () => {
  const events = [];
  const rendered = await renderPluginActionReferenceMarkdown({
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      events.push(`prepare:${packageNames.join(',')}`);
      assert.equal(options.force, true, 'the published reference must render from a fresh Protocol build');
    },
    loadRenderer: async () => {
      events.push('load');
      return { renderPluginActionReferenceMarkdown: () => '# Actions\n' };
    },
  });

  assert.equal(rendered, '# Actions\n');
  assert.deepEqual(events, ['prepare:@happier-dev/protocol', 'load']);
});

test('renders freshly built dependencies after another reference loaded the previous build', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'docs-action-reference-'));
  try {
    const dependencyPath = join(fixture, 'dependency.mjs');
    const rendererPath = join(fixture, 'renderer.mjs');
    await writeFile(dependencyPath, 'export const previous = true;\n');
    // Earlier generators can import the old Protocol graph before the build.
    await import(pathToFileURL(dependencyPath).href);

    const rendered = await renderPluginActionReferenceMarkdown({
      rendererPath,
      ensureWorkspacePackagesBuiltByName: async () => {
        // Model the real build's filesystem output, not the renderer internals.
        await writeFile(dependencyPath, 'export const current = "# Current Actions\\n";\n');
        await writeFile(rendererPath,
          'import { current } from "./dependency.mjs";\n'
          + 'export function renderPluginActionReferenceMarkdown() { return current; }\n');
      },
    });
    assert.equal(rendered, '# Current Actions\n');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
