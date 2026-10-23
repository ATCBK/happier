import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readBuildInputIdentity } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs, readSourcePluginUiBuildInputs } from './workspaceBuildInputs.mjs';

test('source build inputs capture and watch pnpm dependency resolution and policy', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pnpm-build-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await writeFile(fixture.path(name), '');
  }
  const inputs = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'server' });
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.ok(inputs.files.includes(name), `${name} must be captured`);
    assert.ok(inputs.watchPaths.includes(join(fixture.root, name)), `${name} must be watched`);
  }
});

test('source UI preparation captures its declaration projector and invalidates compiler reuse when it changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-declaration-inputs-' });
  await writeFile(fixture.path('package.json'), '{}');
  const owner = 'apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
  await mkdir(dirname(fixture.path(owner)), { recursive: true });
  await writeFile(fixture.path(owner), 'export const declaration = true;\n');
  const capture = await readSourceComponentBuildInputs({ repoDir: fixture.root, component: 'expo' });
  assert.ok(capture.files.includes(owner), 'finite source UI captures its imported projection owner');
  assert.ok(capture.watchPaths.includes(join(fixture.root, owner)), 'source UI observes projection owner changes');
  const compiler = await readSourcePluginUiBuildInputs({ repoDir: fixture.root, compiler: true });
  assert.ok(compiler.includes(owner), 'projection changes participate in the compiler input identity');
  const identity = await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler });
  await writeFile(fixture.path(owner), 'export const declaration = false;\n');
  assert.notEqual(await readBuildInputIdentity({ sourceDir: fixture.root, files: compiler }), identity);
});
