import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

import { ensureWorkspacePackagesBuiltByName, ensureWorkspacePackagesBuiltForComponent } from './ensureWorkspacePackagesBuilt.mjs';
import { copyDirDereferenceContainedSync, vendorRuntimeDependencyTree } from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';

import {
  parseWorkspaceBuildArgs,
  runWorkspacePackageBuild,
} from './ensureWorkspacePackagesBuiltCli.mjs';

for (const compiledAlready of [false, true]) {
  test(`root preparation publishes a real packaged plugin before component copies (${compiledAlready ? 'current dist, missing artifacts' : 'cold compiler outputs'})`, async (t) => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-root-plugin-publication-'));
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
    const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
    const copy = (relativePath) => {
      mkdirSync(dirname(join(repoRoot, relativePath)), { recursive: true });
      cpSync(join(sourceRoot, relativePath), join(repoRoot, relativePath), {
        recursive: true,
        filter: (candidate) => !candidate.split(/[\\/]/u).some((part) => part === 'node_modules' || part === 'dist'),
      });
    };
    for (const relativePath of ['scripts', 'apps/stack/scripts', 'apps/cli/scripts', 'apps/cli/src', 'apps/cli/tsconfig.json']) copy(relativePath);
    const dependencyPackages = ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand', 'transfers', 'peer-mediation'];
    for (const name of dependencyPackages) {
      copy(`packages/${name}`);
    }
    // Physical package custody is part of the real copier's contract. Prepare
    // declared external packages through its owner, not an out-of-root symlink.
    const visited = new Set();
    const vendor = (packageJsonPath, resolveFromPackageJsonPath = packageJsonPath) => vendorRuntimeDependencyTree({
      packageJsonPath, resolveFromPackageJsonPath,
      destNodeModulesDir: join(repoRoot, 'node_modules'), dereferenceRootDir: sourceRoot, visited,
      copyResolvedPackage: ({ sourcePackageDir, destPackageDir, dereferenceRootDir }) => copyDirDereferenceContainedSync({
        sourceDir: sourcePackageDir, destDir: destPackageDir, dereferenceRootDir,
        shouldCopyPath: (candidate) => !relative(sourcePackageDir, candidate).split(/[\\/]/u).includes('node_modules'),
      }),
    });
    for (const name of dependencyPackages) vendor(join(sourceRoot, 'packages', name, 'package.json'));
    const toolchainOwnerPath = join(sourceRoot, 'apps/cli/package.json');
    const toolchain = JSON.parse(readFileSync(toolchainOwnerPath, 'utf8'));
    // The publisher's source loader uses jiti; its authoring input owner uses
    // esbuild. Include their actual CLI declarations alongside the toolchain.
    const dependencies = Object.fromEntries(['tsx', 'typescript', 'yaml', 'jiti', 'esbuild', ...(!compiledAlready ? ['tweetnacl'] : [])].map((name) => {
      const version = toolchain.dependencies?.[name] ?? toolchain.devDependencies?.[name];
      assert.equal(typeof version, 'string', `Fixture toolchain ${name} must be declared`);
      return [name, version];
    }));
    const toolchainPath = join(repoRoot, 'toolchain.json');
    writeFileSync(toolchainPath, JSON.stringify({ dependencies }));
    vendor(toolchainPath, toolchainOwnerPath);
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'] }));
    writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
    mkdirSync(join(repoRoot, 'apps/ui'), { recursive: true });
    writeFileSync(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui' }));
    const packageName = '@happier-dev/plugins-selected';
    const hostDependencies = [...dependencyPackages.map((name) => `@happier-dev/${name}`), packageName];
    for (const component of ['cli', 'server']) {
      const componentDir = join(repoRoot, 'apps', component);
      mkdirSync(componentDir, { recursive: true });
      writeFileSync(join(componentDir, 'package.json'), JSON.stringify({
        name: `@happier-dev/${component}`, type: 'module',
        dependencies: {
          ...Object.fromEntries(hostDependencies.map((name) => [name, '0.0.0'])),
          ...(component === 'cli' && !compiledAlready ? { tweetnacl: dependencies.tweetnacl } : {}),
        },
        bundledDependencies: hostDependencies,
      }));
    }
    const packageDir = join(repoRoot, 'packages/plugins/selected');
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName, version: '0.0.0', type: 'module', main: './dist/index.js',
      files: ['dist', '.happier-plugin', 'package.json'], scripts: { build: 'fixture-compiler' },
    }));
    const manifest = {
      schemaVersion: 2, id: 'happier.selected', version: '0.0.0', displayName: 'Selected',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] }, contributes: {},
    };
    writeFileSync(join(packageDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};\n`);
    const entrypoint = "export { PLUGIN_MANIFEST as manifest } from './manifest.js';\nexport function activate() {}\n";
    writeFileSync(join(packageDir, 'src/index.ts'), entrypoint);
    writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' }, include: ['src/**/*.ts'] }));
    let compilerRuns = 0;
    // Compilation is an external process boundary; retain real admission,
    // fingerprints, publisher, manifest parsing and strict atomic package copies.
    const workspaceBuildBoundary = {
      async prepareEnv(_packageDir, env) { return { ...env }; },
      async runPackageBuild(compiledPackageDir, { env }) {
        if (compiledPackageDir !== packageDir) {
          // Reuse genuine prepared public dependency outputs at the compiler
          // boundary; this fixture never compiles or fakes the CLI application.
          const name = JSON.parse(readFileSync(join(compiledPackageDir, 'package.json'), 'utf8')).name;
          cpSync(join(sourceRoot, 'packages', name.slice('@happier-dev/'.length), 'dist'), env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          return;
        }
        compilerRuns += 1;
        mkdirSync(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), entrypoint);
        writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'manifest.js'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};\n`);
      },
    };
    // A partial temporary plugin corpus prepares target-owned runtime artifacts,
    // not the full checkout's generated native/legacy semantic projections.
    const env = { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_REPO_DIR: repoRoot, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: repoRoot };
    if (compiledAlready) await ensureWorkspacePackagesBuiltByName(repoRoot, hostDependencies, { env, workspaceBuildBoundary });
    assert.equal(existsSync(join(packageDir, '.happier-plugin')), false);
    const result = await runWorkspacePackageBuild({
      repoRoot, env, componentDirs: ['apps/cli', 'apps/server'],
      ensureWorkspacePackagesBuiltForComponentImpl: (componentDir, options) => ensureWorkspacePackagesBuiltForComponent(componentDir, { ...options, env, workspaceBuildBoundary }),
    });
    assert.equal(result.ok, true);
    assert.equal(compilerRuns, 1, 'current compiler output must not be confused with missing publisher output');
    if (compiledAlready) assert.deepEqual(result.built, []);
    for (const component of ['cli', 'server']) {
      const installed = join(repoRoot, 'apps', component, 'node_modules', '@happier-dev/plugins-selected');
      assert.equal(JSON.parse(readFileSync(join(installed, '.happier-plugin/plugin.json'), 'utf8')).id, manifest.id);
      assert.equal(readFileSync(join(installed, '.happier-plugin/daemon.js'), 'utf8'), readFileSync(join(packageDir, '.happier-plugin/daemon.js'), 'utf8'));
      const runtime = await import(pathToFileURL(join(installed, '.happier-plugin/daemon.js')).href);
      assert.equal(typeof runtime.activate, 'function');
    }
    if (!compiledAlready) {
      // Currentness must use the same execution-root inputs as the builder,
      // not this test process's shared-checkout environment.
      const readinessProcess = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const { syncCliRuntimeDependencies, publishSourceDevReadinessFromRuntimeClosure } = await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/cli/scripts/buildSharedDeps.mjs')).href)});\n`
        + 'syncCliRuntimeDependencies({ repoRoot: process.cwd() });\n'
        + `process.stdout.write(JSON.stringify(publishSourceDevReadinessFromRuntimeClosure({ repoRoot: process.cwd(), workspaceNames: ${JSON.stringify(hostDependencies)} })));`,
      ], { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(readinessProcess.status, 0, readinessProcess.stderr);
      const readiness = JSON.parse(readinessProcess.stdout);
      assert.deepEqual(readiness, { stamped: true }, 'archive input must carry genuine verified runtime readiness');
      const workflow = yaml.load(readFileSync(join(sourceRoot, '.github/workflows/tests.yml'), 'utf8'));
      const action = yaml.load(readFileSync(join(sourceRoot, '.github/actions/install-yarn-dependencies/action.yml'), 'utf8'));
      const runnerTemp = join(repoRoot, 'runner-temp');
      mkdirSync(runnerTemp);
      const archive = workflow.jobs['gate-prepare'].steps.find((step) => step.name === "Archive the current run's coherent preparation");
      const archived = spawnSync('bash', ['-c', archive.run], { cwd: repoRoot, env: { ...env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8' });
      assert.equal(archived.status, 0, `${archived.stdout}\n${archived.stderr}`);
      const restoredRoot = join(repoRoot, 'restored');
      mkdirSync(restoredRoot);
      mkdirSync(join(runnerTemp, 'gate-prepared'));
      cpSync(join(runnerTemp, 'gate-prepared-workspace.tar'), join(runnerTemp, 'gate-prepared/gate-prepared-workspace.tar'));
      const restore = action.runs.steps.find((step) => step.name === "Restore this run's prepared workspace");
      const restored = spawnSync('bash', ['-c', restore.run], {
        cwd: restoredRoot, env: { ...env, RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: restoredRoot, RESTORE_STARTED_SECONDS: String(Math.floor(Date.now() / 1000)) }, encoding: 'utf8',
      });
      assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
      for (const output of ['.happier-plugin/plugin.json', '.happier-plugin/daemon.js']) {
        assert.equal(readFileSync(join(restoredRoot, 'packages/plugins/selected', output), 'utf8'), readFileSync(join(packageDir, output), 'utf8'));
      }
      const stamp = '.project/tmp/cli-source-dev-shared-deps-sync.json';
      assert.equal(readFileSync(join(restoredRoot, stamp), 'utf8'), readFileSync(join(repoRoot, stamp), 'utf8'));
    }
  });
}

test('the root package-build adapter delegates one package set to the canonical currentness owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta', 'alpha'],
    ensureWorkspacePackagesBuiltByNameImpl: async (repoRoot, packageNames, options) => {
      calls.push({ repoRoot, packageNames, options });
      return { ok: true, built: ['beta'], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.equal(typeof calls[0].options.onPackageBuildResult, 'function');
  assert.deepEqual(calls.map(({ options: { onPackageBuildResult, ...options }, ...call }) => ({ ...call, options })), [{
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta'],
    options: { publicationMode: 'live', env: process.env },
  }]);
  assert.deepEqual(result, { ok: true, built: ['beta'], skipped: [] });
});

test('the root package-build adapter rejects an empty package selection', async () => {
  await assert.rejects(
    runWorkspacePackageBuild({ repoRoot: '/repo', packageNames: [] }),
    /requires at least one workspace package name/,
  );
});

test('the root package-build adapter prepares component dependency closures through the canonical owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    componentDirs: ['apps/cli', 'apps/server', 'apps/cli'],
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir, options) => {
      calls.push({ componentDir, options });
      return { ok: true, built: [componentDir.split('/').at(-1)], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.ok(calls.every(({ options }) => typeof options.onPackageBuildResult === 'function'));
  assert.deepEqual(calls.map(({ options: { onPackageBuildResult, ...options }, ...call }) => ({ ...call, options })), [
    { componentDir: '/repo/apps/cli', options: { publicationMode: 'live', env: process.env, deferBundledWorkspaceSync: true } },
    { componentDir: '/repo/apps/server', options: { publicationMode: 'live', env: process.env, deferBundledWorkspaceSync: true } },
  ]);
  assert.deepEqual(result, { ok: true, built: ['cli', 'server'], skipped: [] });
});

test('the root package-build adapter publishes the deduplicated rebuilt union once after every build', async () => {
  const events = [];
  const env = { HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    env,
    componentDirs: ['apps/ui', 'apps/cli'],
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir) => {
      events.push(`build:${componentDir}`);
      return componentDir.endsWith('/ui')
        ? {
            ok: true,
            built: ['@happier-dev/plugins-inspector', '@happier-dev/plugin-ui'],
            skipped: [],
          }
        : {
            ok: true,
            built: ['@happier-dev/plugins-inspector', '@happier-dev/plugins-triage'],
            skipped: [],
          };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async (options) => {
      events.push(['publish', options]);
      return true;
    },
    rebuildWorkspacesInvalidatedByBundledPluginPublicationImpl: async (options) => {
      events.push(['rebuild-generated', options]);
      return [];
    },
  });

  assert.deepEqual(events, [
    'build:/repo/apps/ui',
    'build:/repo/apps/cli',
    ['publish', {
      repoRoot: '/repo',
      workspaceNames: [
        '@happier-dev/plugins-inspector',
        '@happier-dev/plugin-ui',
        '@happier-dev/plugins-triage',
      ],
      env,
      pluginFailures: [],
      bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
    }],
    ['rebuild-generated', {
      repoRoot: '/repo',
      workspaceNames: [
        '@happier-dev/plugins-inspector',
        '@happier-dev/plugin-ui',
        '@happier-dev/plugins-triage',
      ],
      env,
    }],
  ]);
  assert.deepEqual(result, {
    ok: true,
    built: [
      '@happier-dev/plugins-inspector',
      '@happier-dev/plugin-ui',
      '@happier-dev/plugins-triage',
    ],
    skipped: [],
  });
});

test('the authoritative root package-build adapter retains full publication', async () => {
  const publications = [];
  await runWorkspacePackageBuild({
    repoRoot: '/repo',
    env: {},
    packageNames: ['@happier-dev/plugins-inspector'],
    ensureWorkspacePackagesBuiltByNameImpl: async () => ({
      ok: true,
      built: ['@happier-dev/plugins-inspector'],
      skipped: [],
    }),
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async (options) => {
      publications.push(options);
      return false;
    },
  });

  assert.deepEqual(publications, [{
    repoRoot: '/repo',
    workspaceNames: ['@happier-dev/plugins-inspector'],
    env: {},
    pluginFailures: [],
    bundledPluginArtifactPublication: { mode: 'write' },
  }]);
});

test('the root package-build CLI separates package names from component preparation paths', () => {
  assert.deepEqual(parseWorkspaceBuildArgs([
    '@happier-dev/protocol',
    '--for-component=apps/cli',
    '--for-component=apps/server',
  ]), {
    packageNames: ['@happier-dev/protocol'],
    componentDirs: ['apps/cli', 'apps/server'],
  });
});
