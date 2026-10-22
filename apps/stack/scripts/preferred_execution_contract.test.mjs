import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectWorkspacePackageJsonPaths } from './utils/proc/workspace_package_manifests.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const preferredScriptNames = ['test', 'test:unit', 'typecheck', 'vitest'];

async function resolveWorkspacePackageFiles() {
  return ['package.json', ...(await collectWorkspacePackageJsonPaths(repoRoot))
    .map((packageFile) => relative(repoRoot, packageFile))];
}

function preferredExecutionLauncher(packageFile) {
  const packageDirectory = dirname(packageFile);
  const relativeLauncher = packageDirectory === '.'
    ? 'apps/stack/bin/hstack-exec'
    : packageDirectory === 'apps/stack'
      ? './bin/hstack-exec'
      : packageDirectory.startsWith('apps/')
        ? '../stack/bin/hstack-exec'
        : packageDirectory.startsWith('packages/plugins/')
          ? '../../../apps/stack/bin/hstack-exec'
          : '../../apps/stack/bin/hstack-exec';
  return relativeLauncher;
}

test('ordinary internal test and typecheck entry points use preferred execution with explicit local owners', async () => {
  const packageFiles = await resolveWorkspacePackageFiles();
  for (const packageFile of packageFiles) {
    const pkg = JSON.parse(await readFile(join(repoRoot, packageFile), 'utf8'));
    for (const script of preferredScriptNames) {
      if (typeof pkg.scripts?.[script] !== 'string') continue;
      assert.equal(
        pkg.scripts[`pre${script}`],
        undefined,
        `${packageFile} ${script} must route before running its preparation work`,
      );
      assert.match(
        pkg.scripts[script],
        new RegExp(`^${preferredExecutionLauncher(packageFile).replaceAll('/', '\\/')} --script=${script}:local$`),
        `${packageFile} ${script} must prefer configured remote execution`,
      );
      assert.equal(
        typeof pkg.scripts[`${script}:local`],
        'string',
        `${packageFile} ${script} must retain an explicit local implementation`,
      );
    }
  }
});

test('the repository exposes one preferred-execution wrapper for arbitrary bounded commands', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.exec, 'apps/stack/bin/hstack-exec');
});
