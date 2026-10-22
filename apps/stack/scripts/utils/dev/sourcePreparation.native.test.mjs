import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runSourceBuildCommand } from '../proc/runSourceBuildCommand.mjs';
import { isDevStartupSourceDrift, prepareSourceComponent } from './devReloadCoordinator.mjs';

test('source daemon preparation retries after a native Go input is corrected', { timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-daemon-native-inputs-' });
  const repoDir = fixture.path('repo');
  const nativeDir = join(repoDir, 'apps/cli/native/processcustody');
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.mkdir(join(repoDir, 'packages'));
  await fs.mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  await fs.mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  await fs.mkdir(join(repoDir, 'apps/ui/scripts'), { recursive: true });
  await fs.writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
  for (const name of ['prepareSourcePluginUiArtifacts.mjs', 'generateBundledPluginUiArtifacts.mjs']) {
    await fs.writeFile(join(repoDir, 'apps/ui/scripts', name), '');
  }
  await fs.writeFile(join(repoDir, 'pnpm-lock.yaml'), '');
  await fs.writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await fs.writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  // Exercise source diagnostics with the installed compiler, without asking Go
  // to download an unrelated toolchain before it can read the broken input.
  await fs.writeFile(join(nativeDir, 'go.mod'), 'module fixture\n');
  const source = join(nativeDir, 'main.go');
  await fs.writeFile(source, 'package main\nfunc main() { broken syntax }\n');
  const abort = new AbortController();
  let completion;
  t.after(async () => { abort.abort(); await completion; });
  let reportFailure;
  const failed = new Promise(resolve => { reportFailure = resolve; });
  const preparing = prepareSourceComponent({ repoDir, target: 'daemon', signal: abort.signal,
    env: { ...process.env, HAPPIER_STACK_DEV_RELOAD_POLL_MS: '20' },
    logger: { log() {}, warn() {}, error() { reportFailure(); } },
    async prepare() {
      // The compiler is external; source admission, drift classification,
      // input discovery and filesystem watching remain real.
      await runSourceBuildCommand({ repoDir, command: 'go', cwd: nativeDir,
        args: ['build', '-o', fixture.path('custody'), '.'] });
      return { ready: true };
    },
  });
  completion = preparing.then(result => ({ result }), error => ({ error }));
  assert.deepEqual(await Promise.race([failed.then(() => 'waiting'), completion]), 'waiting');
  t.diagnostic('Observed the native compiler failure; correcting only main.go');
  await fs.writeFile(source, 'package main\nfunc main() {}\n');
  let timer;
  try {
    const result = await Promise.race([completion, new Promise(resolve => {
      timer = setTimeout(() => resolve({ nativeCorrectionNotObserved: true }), 5000);
    })]);
    assert.deepEqual(result, { result: { ready: true } });
  } finally { clearTimeout(timer); }
});

test('native preparation does not mistake Go configuration or OS errors for source drift', () => {
  for (const message of ['go: cannot find GOROOT directory', 'go.mod:3: unknown directive: broken',
    './main.go:2:1: permission denied', 'listen EADDRINUSE']) {
    assert.equal(isDevStartupSourceDrift({ code: 1, message }, 'daemon'), false);
  }
});
