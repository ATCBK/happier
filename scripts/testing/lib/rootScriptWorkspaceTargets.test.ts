import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSharedPackageTestCommands } from './sharedPackageTestCommands.ts';

import {
  matchesWorkspaceScriptTarget,
  resolveRootScriptWorkspaceTargets,
  resolveScriptNodeTestFiles,
  scanPnpmInvocations,
} from './rootScriptWorkspaceTargets.ts';

test('reads pnpm filter and directory scripts without crediting binary execution as a script', () => {
  const scan = scanPnpmInvocations(
    'pnpm --filter @happier-dev/app --silent run test:unit '
    + '&& pnpm --dir packages/relay-server run test '
    + '&& pnpm --silent run test:integration '
    + '&& pnpm exec test:binary && pnpm --filter @happier-dev/cli exec vitest run',
  );

  assert.deepEqual(scan.workspaceTargets, [
    { packageName: '@happier-dev/app', workspaceDirectory: null, scriptName: 'test:unit' },
    { packageName: null, workspaceDirectory: 'packages/relay-server', scriptName: 'test' },
  ]);
  assert.deepEqual(scan.rootScriptRefs, ['test:integration']);
});

test('follows the Stack executor and root script delegation to the real workspace set', () => {
  const targets = resolveRootScriptWorkspaceTargets(
    {
      test: 'apps/stack/bin/hstack-exec --script=test:local',
      'test:local': 'pnpm --silent run test:unit:local',
      'test:unit:local': 'pnpm --filter privacy-kit --silent run test && pnpm --dir apps/stack --silent run test:unit',
      'test:integration': 'pnpm --filter @happier-dev/app --silent run test:integration',
    },
    'test',
  );

  assert.deepEqual(targets, [
    { packageName: 'privacy-kit', workspaceDirectory: null, scriptName: 'test' },
    { packageName: null, workspaceDirectory: 'apps/stack', scriptName: 'test:unit' },
  ]);
});

test('resolves the declarative shared-package runner without a second package list', () => {
  const targets = resolveRootScriptWorkspaceTargets(
    {
      test: 'pnpm --silent run test:shared-packages:local',
      'test:shared-packages:local': 'node --experimental-strip-types scripts/testing/runSharedPackageTests.ts',
    },
    'test',
  );

  assert.ok(targets.some((target) => target.packageName === '@happier-dev/peer-transport'));
  assert.ok(targets.some((target) => target.packageName === '@happier-dev/release-runtime'));
  assert.ok(targets.some((target) => target.workspaceDirectory === 'packages/relay-server'));
  assert.ok(!targets.some((target) => target.packageName === '@happier-dev/website'));
  assert.ok(!targets.some(
    (target) => target.packageName === 'privacy-kit' && target.scriptName === 'test:runtime:bun',
  ));
});

test('stops instead of looping when root scripts delegate to each other', () => {
  const targets = resolveRootScriptWorkspaceTargets(
    { test: 'pnpm --silent run test:alias', 'test:alias': 'pnpm --silent run test && pnpm --filter privacy-kit --silent run test' },
    'test',
  );

  assert.deepEqual(targets, [{ packageName: 'privacy-kit', workspaceDirectory: null, scriptName: 'test' }]);
});

test('projects the shared runner selected CI inventory rather than defaulting to local mode', () => {
  const runner = 'node --experimental-strip-types scripts/testing/runSharedPackageTests.ts --mode ci';
  const expected = selectSharedPackageTestCommands('ci').flatMap(({ args }) =>
    scanPnpmInvocations(`pnpm ${args.join(' ')}`).workspaceTargets);

  assert.deepEqual(scanPnpmInvocations(runner).workspaceTargets, expected);
  assert.deepEqual(resolveRootScriptWorkspaceTargets({ test: runner }, 'test'), expected);
  assert.throws(
    () => scanPnpmInvocations(runner.replace('--mode ci', '--mode unknown')),
    /Usage: runSharedPackageTests/,
  );
});

test('matches a workspace by package name or by directory', () => {
  const workspace = { packageName: '@happier-dev/relay-server', workspaceDirectory: 'packages/relay-server', scriptName: 'test' };

  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: null, workspaceDirectory: 'packages/relay-server', scriptName: 'test' }),
    true,
  );
  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: '@happier-dev/relay-server', workspaceDirectory: null, scriptName: 'test:unit' }),
    true,
  );
  assert.equal(
    matchesWorkspaceScriptTarget(workspace, { packageName: '@happier-dev/other', workspaceDirectory: 'packages/other', scriptName: 'test' }),
    false,
  );
});

test('follows `pnpm run <script>` delegation like any other script reference', () => {
  const scan = scanPnpmInvocations('pnpm run test:unit:local');
  assert.deepEqual(scan.rootScriptRefs, ['test:unit:local']);

  const files = resolveScriptNodeTestFiles(
    {
      test: '../stack/bin/hstack-exec --script=test:local',
      'test:local': 'pnpm run test:unit:local',
      'test:unit:local': 'vitest run && node --test scripts/prepack-script.test.mjs',
    },
    'test',
  );

  assert.deepEqual(files, ['scripts/prepack-script.test.mjs']);
});
