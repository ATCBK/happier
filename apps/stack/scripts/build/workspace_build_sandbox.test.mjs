import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceBuildSandbox } from './workspace_build_sandbox.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { execPnpm } from '../../../../scripts/workspaces/execPnpmCommand.mjs';

test('createWorkspaceBuildSandbox runs real pnpm tasks with private state and shared dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-sandbox-pnpm-state-' });
  const repoRoot = fixture.root;
  const packageDir = join(repoRoot, 'apps', 'server');
  const agentsDir = join(repoRoot, 'packages', 'agents');
  const nodeModulesDir = join(repoRoot, 'node_modules');

  await mkdir(packageDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  const stateName = '.pnpm-task-run-state-v1';
  await mkdir(join(nodeModulesDir, stateName), { recursive: true });
  await writeFile(join(nodeModulesDir, stateName, 'sentinel'), 'source state');
  await mkdir(join(nodeModulesDir, '@fixture/dependency'), { recursive: true });
  await writeFile(join(nodeModulesDir, '@fixture/dependency/index.js'), 'module.exports = 42;');
  await mkdir(join(nodeModulesDir, 'fixture-tool'));
  await writeFile(join(nodeModulesDir, 'fixture-tool/cli.cjs'),
    "require('fs').appendFileSync('built.txt', String(require('@fixture/dependency')) + '\\n');");
  await mkdir(join(nodeModulesDir, '.bin'));
  const binPath = join(nodeModulesDir, '.bin', process.platform === 'win32' ? 'fixture-tool.cmd' : 'fixture-tool');
  await writeFile(binPath, process.platform === 'win32'
    ? '@node "%~dp0\\..\\fixture-tool\\cli.cjs"\r\n'
    : "#!/usr/bin/env node\nrequire('../fixture-tool/cli.cjs');\n");
  await chmod(binPath, 0o755);
  await writeFile(join(nodeModulesDir, '.modules.yaml'), 'nodeLinker: hoisted\n');
  await writeFile(join(repoRoot, 'package.json'), '{"private":true}');
  await writeFile(join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@fixture/server', scripts: { probe: 'fixture-tool' },
  }));
  await writeFile(join(agentsDir, 'package.json'), '{}');
  await writeFile(join(nodeModulesDir, 'sentinel.txt'), 'reachable');

  const sandbox = await createWorkspaceBuildSandbox({
    packageDir,
    extraRelativePaths: ['packages/agents'],
  });
  t.after(() => sandbox.cleanup());
  const pnpmOptions = { cwd: sandbox.sandboxRoot, encoding: 'utf8', stdio: 'pipe', preferPath: true };
  const version = execPnpm(['--version'], pnpmOptions).trim();
  t.diagnostic(`real pnpm ${version} on ${process.platform}`);
  assert.match(version, /^12\./, 'this regression must exercise pnpm 12 task-state validation');
  for (let run = 0; run < 2; run += 1) {
    execPnpm(['--filter', '@fixture/server', 'run', 'probe'], pnpmOptions);
  }
  assert.equal(await readFile(join(sandbox.sandboxPackageDir, 'built.txt'), 'utf8'), '42\n42\n');
  await assert.rejects(readFile(join(packageDir, 'built.txt')), { code: 'ENOENT' });
  const sandboxModules = join(sandbox.sandboxRoot, 'node_modules');
  assert.equal((await lstat(sandboxModules)).isSymbolicLink(), false);
  assert.equal((await lstat(join(sandboxModules, stateName))).isDirectory(), true);
  assert.equal((await lstat(join(sandboxModules, stateName))).isSymbolicLink(), false);
  assert.deepEqual(await readdir(join(nodeModulesDir, stateName)), ['sentinel']);
  assert.equal(await readFile(join(nodeModulesDir, stateName, 'sentinel'), 'utf8'), 'source state');
  await assert.rejects(readFile(join(sandboxModules, stateName, 'sentinel')), { code: 'ENOENT' });
  for (const directory of ['fixture-tool', '@fixture', '.bin']) {
    assert.equal(await realpath(join(sandboxModules, directory)), await realpath(join(nodeModulesDir, directory)));
  }
  assert.equal(await readFile(join(sandboxModules, '.modules.yaml'), 'utf8'), 'nodeLinker: hoisted\n');
  assert.equal((await lstat(join(sandboxModules, '.modules.yaml'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(sandboxModules, 'sentinel.txt'), 'utf8'), 'reachable');
  assert.equal(await readFile(join(sandbox.sandboxRoot, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9\n');
  assert.equal(await readFile(join(sandbox.sandboxRoot, 'pnpm-workspace.yaml'), 'utf8'), 'packages:\n  - apps/*\n');
});
