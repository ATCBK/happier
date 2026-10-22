import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
test('server postinstall runs a native pnpm npm_execpath and respects install scope', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-postinstall-pnpm-'));
  try {
    const serverRoot = join(root, 'apps/server');
    await mkdir(join(serverRoot, 'scripts'), { recursive: true });
    await mkdir(join(root, 'scripts/workspaces'), { recursive: true });
    await mkdir(join(root, 'scripts/postinstall'), { recursive: true });
    await mkdir(join(root, 'packages/cli-common'), { recursive: true });
    await writeFile(join(serverRoot, 'scripts/schemaSync.ts'), '');
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const path of ['scripts/workspaces/execPnpmCommand.mjs', 'scripts/postinstall/shouldRunPostinstall.cjs', 'packages/cli-common/windowsCommandInvocation.mjs']) {
      await copyFile(join(repoRoot, path), join(root, path));
    }
    const pnpmPath = join(root, 'pnpm');
    // A native executable boundary: passing this file to Node must fail.
    await writeFile(pnpmPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(pnpmPath, 0o755);
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps/server/package.json'), 'utf8'));
    const script = manifest.scripts.postinstall;
    assert.ok(script.startsWith('node -e "') && script.endsWith('"'));
    const source = script.slice('node -e "'.length, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const run = (scope) => spawnSync(process.execPath, ['-e', source], {
      cwd: serverRoot,
      env: { ...process.env, npm_execpath: pnpmPath, HAPPIER_INSTALL_SCOPE: scope },
      encoding: 'utf8',
    });
    const executed = run('server');
    assert.equal(executed.status, 0, executed.stderr);
    assert.deepEqual(executed.stdout.trim().split('\n'), ['--silent', 'run', 'postinstall:real']);
    const skipped = run('ui');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.stdout, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
