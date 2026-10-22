import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const launcher = join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');

test('script dispatch preserves a native pnpm executable inherited in npm_execpath', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-pnpm-script-' });
  const nativePnpm = join(root, 'pnpm');
  await writeFile(nativePnpm, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(nativePnpm, 0o755);
  const result = spawnSync('/bin/sh', [launcher, '--local', '--script=probe', '--', 'argument with spaces'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, HAPPIER_HSTACK_EXECUTION: '1',
      HAPPIER_DEV_TARGET_EXECUTION: '1', npm_execpath: nativePnpm, npm_node_execpath: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['run', '--silent', 'probe', 'argument with spaces']);
});
