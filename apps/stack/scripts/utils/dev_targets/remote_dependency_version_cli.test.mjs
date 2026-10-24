import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { readSelectedDependencyVersion } from '../proc/dependency_refresh.mjs';

const bootstrapPath = fileURLToPath(new URL('./remote_dependency_bootstrap.mjs', import.meta.url));

test('explicit bootstrap preparation selects a private version and emits only its root and identity', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dependency-version-cli-' });
  const repoDir = fixture.path('source');
  await mkdir(repoDir);
  const archive = 'dependency-version-cli-fixture';
  const integrity = createHash('sha512').update(archive).digest('hex');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true,
    packageManager: `pnpm@12.14.0+sha512.${integrity}` }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'A');
  for (const name of ['ui', 'cli', 'server', 'stack']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `fixture-${name}` }));
  }
  // Replace only package-manager process boundaries. The source CLI, captured
  // inputs, install owner, readiness records and selection all remain real.
  writeFakeBin({ root: fixture.root, name: 'npm', content: `#!${process.execPath}
    const fs = require('node:fs'); const path = require('node:path');
    const dest = process.argv[process.argv.indexOf('--pack-destination') + 1];
    fs.writeFileSync(path.join(dest, 'pnpm.tgz'), ${JSON.stringify(archive)});
    process.stdout.write(JSON.stringify([{ filename: 'pnpm.tgz' }]));
  ` });
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'pnpm', content: `#!${process.execPath}
    const fs = require('node:fs'); const path = require('node:path');
    if (process.argv.includes('--version')) { process.stdout.write('12.14.0'); process.exit(0); }
    fs.appendFileSync(process.env.HAPPIER_TEST_CLI_INSTALL_LOG, 'install\\n');
    fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'node_modules', '.modules.yaml'), '{}');
    process.stdout.write('package-manager preparation progress\\n');
    if (process.env.HAPPIER_TEST_CLI_INSTALL_FAILURE === '1') process.exit(17);
  ` });
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`, npm_execpath: '',
    HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
    HAPPIER_STACK_PM_CACHE_BASE_DIR: fixture.path('cache'), HAPPIER_TEST_CLI_INSTALL_LOG: fixture.path('installs') };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  delete env.NODE_OPTIONS;
  delete env.HAPPIER_DEPENDENCY_VERSION_ROOT;
  delete env.HAPPIER_DEPENDENCY_VERSION_ID;
  delete env.HAPPIER_DEPENDENCY_SOURCE_ROOT;
  const invoke = extraEnv => {
    try {
      return execFileSync(process.execPath, [bootstrapPath,
        '--prepare-version', '--execution-placement=remote', '--validation-kind=source-test', `--repo-dir=${repoDir}`],
      { cwd: repoDir, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (extraEnv?.HAPPIER_TEST_CLI_INSTALL_FAILURE !== '1') {
        // Preserve safe classification without disclosing fixture subprocess output.
        const stderr = String(error.stderr ?? '');
        error.code = stderr.includes('integrity mismatch') ? 'CLI_FIXTURE_INTEGRITY'
          : stderr.includes('Cannot find') || stderr.includes('MODULE_NOT_FOUND') ? 'CLI_FIXTURE_MODULE'
            : stderr.includes('ENOENT') ? 'CLI_FIXTURE_MISSING_PATH'
              : `CLI_FIXTURE_PROCESS_${error.status}`;
      }
      throw error;
    }
  };
  const output = invoke();
  assert.equal(existsSync(join(repoDir, 'node_modules')), false, 'preparation must never install into the source mirror');
  const a = JSON.parse(output);
  assert.deepEqual(Object.keys(a).sort(), ['dependencyIdentity', 'dependencyRoot']);
  assert.equal((await readSelectedDependencyVersion({ installDir: repoDir, env })).dependencyRoot, a.dependencyRoot);
  assert.ok(a.dependencyRoot.startsWith(fixture.path('cache')));
  assert.deepEqual(JSON.parse(invoke()), a, 'warm explicit preparation reuses its admitted version');
  assert.equal((await readFile(fixture.path('installs'), 'utf8')).trim().split('\n').length, 1);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), 'B');
  assert.throws(() => invoke({ HAPPIER_TEST_CLI_INSTALL_FAILURE: '1' }), error => error.status !== 0 && error.stdout === '');
  assert.equal((await readSelectedDependencyVersion({ installDir: repoDir, env })).dependencyRoot, a.dependencyRoot,
    'failed CLI preparation leaves A selected');
});
