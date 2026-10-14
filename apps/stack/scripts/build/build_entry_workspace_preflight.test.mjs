import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';

import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../testkit/core/spawn_test_process.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';

const buildDir = dirname(fileURLToPath(import.meta.url));
const stackDir = resolve(buildDir, '..', '..');
const buildScriptPath = resolve(stackDir, 'scripts', 'build.mjs');

test('direct Stack artifact entry reaches worker placement before publication and reports missing source', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-build-entry-owner-', registerCleanup: false });
  const lockPath = fixture.path('stacks', 'repo-producer', 'runtime', 'publication.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  let release;
  let admitted;
  const admission = new Promise(resolve => { admitted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withWorkspaceBundleLock(async () => { admitted(); await gate; }, { lockPath });
  await admission;

  // Finite construction is admitted before the short publication transaction.
  // An unrelated publication owner must not block source/worker inspection.
  const child = spawnTestProcess(process.execPath, [buildScriptPath, '--daemon', '--json'], {
    cwd: stackDir,
    env: {
      ...sanitizeStackTestRunnerEnv(process.env, {
        isolatedStackRoot: fixture.root,
        repoDir: fixture.path('missing-source'),
      }),
      HAPPIER_STACK_STACK: 'entry-owner',
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-producer',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const completion = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
  t.after(async () => {
    release();
    await holder;
    await completion;
    await fixture.cleanup();
  });

  const result = await completion;
  assert.notEqual(result.code, 0, 'missing worker source must fail before entering publication');
  assert.equal(result.stdout, '', 'failed publication must not emit a successful JSON result');
  assert.match(result.stderr, /missing-source[\\/]apps[\\/]stack[\\/]bin[\\/]hstack-exec/);
  assert.match(result.stderr, /ENOENT/);
});
