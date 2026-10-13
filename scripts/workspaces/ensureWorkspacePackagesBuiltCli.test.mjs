import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWorkspaceBuildArgs,
  runWorkspacePackageBuild,
} from './ensureWorkspacePackagesBuiltCli.mjs';

test('root workspace preparation forwards its environment and reuses current shared outputs across components', async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'happier-preparation-cli-environment-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(repoRoot, 'yarn.lock'), '# fixture\n');
  const packageDir = join(repoRoot, 'packages/example');
  mkdirSync(join(packageDir, 'src'), { recursive: true });
  writeFileSync(join(packageDir, 'src/index.ts'), 'export const value = "source";\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/example', type: 'module', main: './dist/index.js',
    scripts: { build: 'node compile.mjs' },
  }));
  // The fixture compiler is a genuine child process. Admission, fingerprints,
  // package copying and the root preparation adapter execute their real paths.
  writeFileSync(join(packageDir, 'compile.mjs'), `import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
mkdirSync(output, {recursive: true});
writeFileSync(join(output, 'index.js'), 'export const value = ' + JSON.stringify(process.env.FIXTURE_PREPARATION_VALUE ?? 'missing') + ';\\n');
`);
  for (const app of ['cli', 'ui', 'server']) {
    const dir = join(repoRoot, 'apps', app);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      dependencies: { '@happier-dev/example': '0.0.0' }, bundledDependencies: ['@happier-dev/example'] }));
  }
  const env = { ...process.env, FIXTURE_PREPARATION_VALUE: 'from-root-preparation' };
  const options = { repoRoot, env, componentDirs: ['apps/cli', 'apps/server', 'apps/cli'] };
  const first = await runWorkspacePackageBuild(options);
  assert.deepEqual(first.built, ['@happier-dev/example']);
  for (const app of ['cli', 'server']) {
    assert.equal(readFileSync(join(repoRoot, 'apps', app, 'node_modules/@happier-dev/example/dist/index.js'), 'utf8'),
      'export const value = "from-root-preparation";\n');
  }
  assert.deepEqual((await runWorkspacePackageBuild(options)).built, [], 'a repeated preparation must reuse current outputs');
});

test('the root package-build adapter delegates one package set to the canonical currentness owner', async () => {
  const calls = [];
  const result = await runWorkspacePackageBuild({
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta', 'alpha'],
    ensureWorkspacePackagesBuiltByNameImpl: async (repoRoot, packageNames, { env, onPackageBuildResult, ...options }) => {
      assert.equal(env, process.env);
      assert.equal(typeof onPackageBuildResult, 'function');
      calls.push({ repoRoot, packageNames, options });
      return { ok: true, built: ['beta'], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.deepEqual(calls, [{
    repoRoot: '/repo',
    packageNames: ['alpha', 'beta'],
    options: { publicationMode: 'live' },
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
    ensureWorkspacePackagesBuiltForComponentImpl: async (componentDir, { env, onPackageBuildResult, ...options }) => {
      assert.equal(env, process.env);
      assert.equal(typeof onPackageBuildResult, 'function');
      calls.push({ componentDir, options });
      return { ok: true, built: [componentDir.split('/').at(-1)], skipped: [] };
    },
    publishBundledPluginArtifactsAfterWorkspaceBuildImpl: async () => false,
  });

  assert.deepEqual(calls, [
    { componentDir: '/repo/apps/cli', options: { publicationMode: 'live', deferBundledWorkspaceSync: true } },
    { componentDir: '/repo/apps/server', options: { publicationMode: 'live', deferBundledWorkspaceSync: true } },
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
