import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installCliNativeCustodySourceFixture, installNativeAdmissionFixture, installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { ensureWorkspacePackagesBuiltForComponent } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { withWorkspaceBundleLock } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../../../scripts/workspaces/workspacePackageBuildLock.mjs';

import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';
import { resolveCliBundledWorkspacePackageNames } from '../../../../cli/scripts/buildSharedDeps.mjs';

test('CLI source preparation stages admitted native custody and releases publication before the reader', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cli-source-native-preparation-' });
  await installNativeAdmissionFixture({ root });
  const repoDir = join(root, 'native-owner');
  const source = await installCliNativeCustodySourceFixture(repoDir);
  const cliDir = join(repoDir, 'apps/cli');
  mkdirSync(join(cliDir, 'native/processcustody'), { recursive: true });
  const nativeSource = join(cliDir, 'native/processcustody/main.go');
  writeFileSync(nativeSource, 'native-custody');
  writeFileSync(join(repoDir, 'package.json'), '{"private":true}');
  writeFileSync(join(repoDir, 'pnpm-lock.yaml'), '# source fixture');
  writeFileSync(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const buildRecord = join(root, 'native-build');
  // Go and physical capacity are OS boundaries. The real source setup,
  // native admission, authenticated lease and staging owner remain live.
  writeFakeBin({ root, name: 'go', content: `#!/bin/sh
[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" ] || exit 91
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output=$1; fi
  shift
done
cat '${nativeSource}' > "$output"
printf 'compiled\\n' >> '${buildRecord}'
` });
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "33554432 33554432\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    HAPPIER_EXEC_CONFIG_PATH: '', HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const prepare = (requiredTools = 'go') => prepareRemoteValidationWorkspace({ repoDir,
    componentRelativeDir: 'apps/cli', validationKind: 'source-test', requiredTools, env });

  await prepare('');
  assert.throws(() => readFileSync(buildRecord), { code: 'ENOENT' },
    'projection-only source checks do not acquire a new native prerequisite');

  await prepare();
  assert.deepEqual(new Set(readFileSync(source.tracePath, 'utf8').trim().split('\n').map(value => JSON.parse(value))),
    new Set([source.runtimeTarget, source.setupTarget].map(value => pathToFileURL(value).href)),
    'the selected checkout owns both the source loader and native staging implementation');
  assert.equal(readFileSync(join(cliDir, 'tools/unpacked/happier-process-custody'), 'utf8'), 'native-custody');
  assert.throws(() => readFileSync(join(repoDir, '.project/tmp/cli-dist-build.lock')), { code: 'ENOENT' });
  assert.throws(() => readFileSync(join(cliDir, 'dist/index.mjs')), { code: 'ENOENT' });
  writeFileSync(nativeSource, 'native-custody-current-source');
  await prepare();
  assert.equal(readFileSync(join(cliDir, 'tools/unpacked/happier-process-custody'), 'utf8'), 'native-custody-current-source',
    'an existing binary is not proof that the public preparation consumed current Go source');
  assert.equal(readFileSync(buildRecord, 'utf8'), 'compiled\ncompiled\n');
  assert.throws(() => readFileSync(join(repoDir, '.project/tmp/cli-dist-build.lock')), { code: 'ENOENT' });
});

test('typecheck readers consume last-green declarations while publication leases remain held', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-typecheck-held-publication-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const metadata = { name: '@happier-dev/protocol', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: 'fixture-compiler' } };
  const dependency = join(root, 'packages/protocol');
  mkdirSync(join(dependency, 'src'), { recursive: true });
  writeFileSync(join(dependency, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(dependency, 'src/index.ts'), 'export const value = "green";\n');
  const env = { ...process.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]',
    HAPPIER_BUILD_DEPENDENCY_CUSTODY: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
  for (const component of ['cli', 'ui', 'server']) {
    const dir = join(root, 'apps', component);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${component}`,
      dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
  }
  await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps/server'), { env,
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, value) => value,
      // Only the compiler process is replaced. Publication, fingerprints,
      // dependency admission and retained-output validation remain real.
      runPackageBuild: async (dir, { env }) => {
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src/index.ts')));
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;');
      },
    },
  });
  const record = readFileSync(join(dependency, 'dist/.happier-build-inputs.json'), 'utf8');
  writeFileSync(join(dependency, 'src/index.ts'), 'export const value = "moving";\n');
  await withWorkspaceBundleLock(async () => {
    await withWorkspaceBundleLock(async () => {
      for (const component of ['cli', 'ui', 'server']) {
        const result = await prepareRemoteValidationWorkspace({ repoDir: root,
          componentRelativeDir: `apps/${component}`, validationKind: 'typecheck', env });
        assert.deepEqual(result.built, []);
        assert.deepEqual(result.skipped, ['workspace-typecheck-reader']);
      }
      assert.equal(readFileSync(join(dependency, 'dist/.happier-build-inputs.json'), 'utf8'), record);
      assert.equal(readFileSync(join(dependency, 'dist/index.js'), 'utf8'), 'export const value = "green";\n');
    }, { lockPath: resolveWorkspacePackageBuildLockPath(dependency, metadata) });
  }, { lockPath: join(root, '.project/tmp/cli-dist-build.lock') });
});

test('runtime preparation publishes captured inputs and preserves last-green after compiler failure', async t => {
  for (const scenario of ['warm', 'cold', 'damaged', 'compiler-error']) await t.test(scenario, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-finite-preparation-drift-' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    for (const app of ['cli', 'ui', 'server']) {
      mkdirSync(join(root, 'apps', app), { recursive: true });
      writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
        ...(app === 'server' ? { dependencies: { '@happier-dev/plugin-sdk': 'workspace:*' } } : {}) }));
    }
    const sdk = join(root, 'packages/plugin-sdk');
    mkdirSync(join(sdk, 'src'), { recursive: true });
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk', type: 'module',
      main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'fixture-compiler' } }));
    const source = join(sdk, 'src/index.ts');
    const receipt = join(sdk, 'dist/.happier-build-inputs.json');
    const output = join(sdk, 'dist/index.js');
    writeFileSync(source, 'export const value = "green";\n');
    let moving = false, attempts = 0;
    // Replace only the compiler process. Captures, output integrity and
    // publication remain real, including an edit during compilation.
    const workspaceBuildBoundary = {
      prepareEnv: async (_dir, env) => ({ ...env }),
      runPackageBuild: async (dir, { env }) => {
        attempts++;
        if (moving && scenario === 'compiler-error') throw Object.assign(new Error('src/index.ts(1,1): error TS2322: incompatible value'), { code: 'EEXIT', exitCode: 1 });
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), readFileSync(join(dir, 'src/index.ts')));
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: string;\n');
        if (moving) writeFileSync(source, `export const value = "moving-${attempts}";\n`);
      },
    };
    const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict',
      HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root };
    if (scenario !== 'cold') await ensureWorkspacePackagesBuiltForComponent(join(root, 'apps/server'), {
      env, workspaceBuildBoundary,
    });
    const greenRecord = scenario === 'cold' ? null : JSON.parse(readFileSync(receipt, 'utf8'));
    if (scenario === 'damaged') writeFileSync(output, 'damaged retained output');
    writeFileSync(source, 'export const value = "next";\n');
    moving = true;
    attempts = 0;
    const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/server',
        validationKind: 'runtime',
        env,
        loadWorkspaceBuildOwner: async () => ({
          ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
            ...options, workspaceBuildBoundary,
          }),
        }),
      });
    if (scenario === 'compiler-error') {
      await assert.rejects(prepare(), { code: 'EEXIT' });
      assert.equal(attempts, 1);
      assert.equal(readFileSync(output, 'utf8'), 'export const value = "green";\n');
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), greenRecord);
      return;
    }
    const result = await prepare();
    assert.equal(attempts, 1, 'a captured compiler input does not need a trailing pass');
    assert.deepEqual(result.built, ['@happier-dev/plugin-sdk']);
    assert.equal(readFileSync(output, 'utf8'), 'export const value = "next";\n');
    assert.equal(readFileSync(source, 'utf8'), 'export const value = "moving-1";\n');
    const capturedRecord = readFileSync(receipt, 'utf8');
    moving = false;
    const recovered = await prepare();
    assert.deepEqual(recovered.built, ['@happier-dev/plugin-sdk']);
    assert.equal(recovered.stalePackages?.length ?? 0, 0);
    assert.equal(readFileSync(output, 'utf8'), 'export const value = "moving-1";\n');
    assert.notEqual(readFileSync(receipt, 'utf8'), capturedRecord, 'the later source edit is prepared by the next producer invocation');
  });
});

test('cold CLI artifact publication builds the selected plugin before invoking its artifact consumer', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cold-plugin-dist-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/plugins/*"\n');
  const cli = join(root, 'apps/cli');
  const plugin = join(root, 'packages/plugins/claude');
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  mkdirSync(join(cli, 'scripts/build-owned'), { recursive: true });
  mkdirSync(join(plugin, 'src'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    bundledDependencies: ['@happier-dev/plugins-claude'], dependencies: { '@happier-dev/plugins-claude': 'workspace:*' } }));
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-claude',
    version: '0.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: 'node compile.mjs' } }));
  writeFileSync(join(plugin, 'src/manifest.ts'), 'export const PLUGIN_MANIFEST = { id: "happier.agent.claude", runtime: { apiVersion: 1 }, contributes: {} };\n');
  writeFileSync(join(plugin, 'src/index.ts'), 'export const generation = 1;\n');
  writeFileSync(join(plugin, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src'] }));
  // Compiler and generator subprocesses are system boundaries. Real membership,
  // package build ordering, output admission and publication dispatch stay live.
  writeFileSync(join(plugin, 'compile.mjs'), `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true });
writeFileSync(out + '/index.js', readFileSync('src/index.ts')); writeFileSync(out + '/index.d.ts', 'export declare const generation: number;');`);
  const heapLauncher = fileURLToPath(new URL('../../../../cli/scripts/withNodeHeapLimit.mjs', import.meta.url));
  writeFileSync(join(cli, 'scripts/withNodeHeapLimit.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [${JSON.stringify(heapLauncher)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error; process.exit(result.status ?? 1);`);
  writeFileSync(join(cli, 'scripts/build-owned/generateBundledPluginEntries.ts'), `import { readFileSync, writeFileSync } from 'node:fs';
const root = process.argv[process.argv.indexOf('--root') + 1];
const dist = readFileSync(root + '/packages/plugins/claude/dist/index.js', 'utf8');
writeFileSync(root + '/published-plugin', dist);`);
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'apps/cli', validationKind: 'runtime', env: native.env });
  assert.deepEqual(resolveCliBundledWorkspacePackageNames({ repoRoot: root }), ['plugins-claude']);
  await prepare();
  assert.equal(readFileSync(join(root, 'published-plugin'), 'utf8'), 'export const generation = 1;\n');
  writeFileSync(join(plugin, 'src/index.ts'), 'export const generation = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(root, 'published-plugin'), 'utf8'), 'export const generation = 2;\n');
});

test('source-test and typecheck readers leave cold, current and stale outputs to their producers', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-preparation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const cli = join(root, 'apps/cli');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(cli, { recursive: true });
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@fixture/cli', dependencies: { '@fixture/protocol': 'workspace:*' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  writeFileSync(join(protocol, 'compile.mjs'), 'import { mkdirSync, writeFileSync } from "node:fs"; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.js", "export const value = 1;\\n");');
  const source = join(protocol, 'src/index.ts');
  writeFileSync(source, 'export const value = 1;\n');
  const prepare = async () => {
    for (const componentRelativeDir of ['apps/cli', 'apps/ui', 'packages/plugin-sdk']) {
      for (const validationKind of ['source-test', 'typecheck']) {
        await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir, validationKind });
      }
    }
  };
  await prepare();
  assert.throws(() => readFileSync(join(protocol, 'dist/index.js')), { code: 'ENOENT' });
  mkdirSync(join(protocol, 'dist'), { recursive: true });
  writeFileSync(join(protocol, 'dist/index.js'), 'export const value = 1;\n');
  await prepare();
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
});

test('source-test collection follows Protocol source edits and rejects malformed reachable source without dist', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-collection-' });
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const vitestEntry = fileURLToPath(import.meta.resolve('vitest'));
  const vitestCli = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
  const source = join(root, 'protocol/src');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(root, 'protocol/package.json'), JSON.stringify({
    name: '@happier-dev/protocol', exports: { '.': { default: './dist/index.js' } },
  }));
  const config = join(root, 'vitest.config.mts');
  writeFileSync(config, `import { createWorkspacePackageSourcesPlugin } from ${JSON.stringify(join(repoRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts'))};
export default { plugins: [createWorkspacePackageSourcesPlugin([{ packageName: '@happier-dev/protocol', packageSourceRoot: ${JSON.stringify(source)} }])], test: { include: ['owner.test.ts'], pool: 'forks', maxWorkers: 1 } };`);
  const writeSourceAndExpectation = value => {
    writeFileSync(join(source, 'index.ts'), `export const value = ${value};\n`);
    writeFileSync(join(root, 'owner.test.ts'), `import { test, expect } from ${JSON.stringify(vitestEntry)}; import { value } from '@happier-dev/protocol'; test('current source', () => expect(value).toBe(${value}));`);
  };
  // This isolated resolver fixture already runs beneath the containing native
  // test's admission. A second package dispatch would prepare unrelated dist.
  const collect = () => spawnSync(process.execPath, [vitestCli, 'run', `--root=${root}`, `--config=${config}`], {
    cwd: join(repoRoot, 'apps/cli'), env: process.env, encoding: 'utf8',
  });
  writeSourceAndExpectation(1);
  let result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeSourceAndExpectation(2);
  result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeFileSync(join(source, 'index.ts'), 'export const value = ;\n');
  result = collect();
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Failed Suites|Transform failed/);
});

test('artifact-consuming preparation publishes cold outputs, reuses current outputs and rebuilds stale outputs', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-artifact-preparation-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['ui', 'cli', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version: '1.0.0' }));
  }
  const sdk = join(root, 'packages/plugin-sdk');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(sdk, { recursive: true });
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@fixture/sdk', dependencies: { '@fixture/protocol': '1.0.0' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', type: 'module', version: '1.0.0', main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
  const count = join(root, 'builds');
  writeFileSync(join(protocol, 'compile.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); const source = readFileSync('src/index.ts', 'utf8'); writeFileSync(out + '/index.js', source); writeFileSync(out + '/index.d.ts', 'export declare const value: number;'); appendFileSync(${JSON.stringify(count)}, 'build\\n');`);
  const source = join(protocol, 'src/index.ts');
  const prepare = () => prepareRemoteValidationWorkspace({
    repoDir: root, componentRelativeDir: 'packages/plugin-sdk', validationKind: 'runtime',
    // The fixture owns both the physical inputs and canonical checkout identity.
    env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict',
      HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: root },
  });
  writeFileSync(source, 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(count, 'utf8'), 'build\n');
  // A public build's prebuild repeats ordinary strict preparation after the
  // remote producer has released its capture/publication custody.
  await ensureWorkspacePackagesBuiltForComponent(sdk, {
    env: { ...native.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_STACK_REPO_DIR: root },
  });
  assert.equal(readFileSync(count, 'utf8'), 'build\n', 'the admitted payload must reuse its captured strict prerequisites');
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(count, 'utf8'), 'build\nbuild\n');
});

test('remote validation preparation delegates component dependency outputs to the canonical workspace owner', async () => {
  const calls = [];
  const publicationCalls = [];
  const result = await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/cli',
    env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (...args) => {
        calls.push(args);
        return { ok: true, built: ['@happier-dev/plugins-codex'], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: (options) => {
        assert.deepEqual(options, { repoRoot: '/remote/happier' });
        // Exact mixed CLI bundled selection shape: host workspaces plus bundled
        // plugins, as produced by the canonical bundled workspace resolver.
        return ['protocol', 'agents', 'plugins-codex', 'plugins-claude'];
      },
      publishBundledPluginArtifactsAfterWorkspaceBuild: async (options) => {
        publicationCalls.push(options);
        return true;
      },
    }),
  });

  assert.deepEqual(calls, [[
    '/remote/happier/apps/cli',
    { env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' }, isolatePluginFailures: true },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    built: ['@happier-dev/plugins-codex'],
    skipped: [],
  });
  assert.deepEqual(publicationCalls, [{
    repoRoot: '/remote/happier',
    workspaceNames: ['protocol', 'agents', 'plugins-codex', 'plugins-claude'],
    env: { TEST_ENV: '1', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' },
    publicationMode: 'live',
    bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
  }]);
});

test('remote development validation isolates an optional plugin at the real package build boundary', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-optional-validation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/plugins/*"\n');
  const ui = join(root, 'apps/ui');
  const inspector = join(root, 'packages/plugins/inspector');
  mkdirSync(ui, { recursive: true });
  mkdirSync(join(root, 'apps/cli'), { recursive: true });
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli' }));
  writeFileSync(join(root, 'apps/server/package.json'), JSON.stringify({ name: '@fixture/server' }));
  mkdirSync(inspector, { recursive: true });
  writeFileSync(join(ui, 'package.json'), JSON.stringify({
    name: '@fixture/ui', dependencies: { '@happier-dev/plugins-inspector': 'workspace:*' },
  }));
  writeFileSync(join(inspector, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-inspector', main: './dist/index.js', scripts: { build: 'fixture-compiler' },
  }));
  const result = await prepareRemoteValidationWorkspace({
    repoDir: root, componentRelativeDir: 'apps/ui', validationKind: 'runtime',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
        ...options, quiet: true,
        workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async () => { throw new Error('optional UI compiler failed'); },
        },
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pluginFailures.map((failure) => failure.packageName), ['@happier-dev/plugins-inspector']);
  assert.match(result.pluginFailures[0].diagnostic.message, /optional UI compiler failed/);
});

test('remote validation preparation does not publish CLI projections for unrelated components', async () => {
  let loadedCliOwner = false;
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'packages/protocol',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async () => ({ ok: true, built: [], skipped: [] }),
    }),
    loadCliBuildOwner: async () => {
      loadedCliOwner = true;
      throw new Error('unrelated component must not load the CLI publisher');
    },
  });
  assert.equal(loadedCliOwner, false);
});

test('remote UI validation publishes source-derived manifests before component preparation validates plugins', async () => {
  const events = [];
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/ui',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (componentDir) => {
        events.push(`prepare:${componentDir}`);
        return { ok: true, built: [], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: () => ['protocol', 'plugins-codex'],
      publishBundledPluginArtifactsAfterWorkspaceBuild: async () => {
        events.push('publish');
        return true;
      },
    }),
  });
  assert.deepEqual(events, [
    'publish',
    'prepare:/remote/happier/apps/ui',
    'prepare:/remote/happier/apps/cli',
  ]);
});

test('remote validation preparation rejects paths outside the synchronized repository', async () => {
  await assert.rejects(
    prepareRemoteValidationWorkspace({
      repoDir: '/remote/happier',
      componentRelativeDir: '../outside',
    }),
    /inside the synchronized repository/i,
  );
});
