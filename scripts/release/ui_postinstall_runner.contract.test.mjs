import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');
const uiPostinstallPath = join(repoRoot, 'apps', 'ui', 'tools', 'postinstall.mjs');
const uiPostinstallRunnerPath = join(repoRoot, 'apps', 'ui', 'tools', 'postinstall', 'runUiPostinstall.cjs');
const require = createRequire(import.meta.url);

test('ui postinstall distinguishes a workspace junction from an installed package on Windows', () => {
  const { isInstalledPackageContext, runUiPostinstall } = require(uiPostinstallRunnerPath);
  const workspaceJunction = 'D:\\a\\happier\\happier\\node_modules\\@happier-dev\\app';
  const physicalWorkspace = 'D:\\a\\happier\\happier\\apps\\ui';

  assert.equal(
    isInstalledPackageContext({
      cwd: workspaceJunction,
      realpathSync: () => physicalWorkspace,
    }),
    false,
    'a workspace junction must run the app-owned postinstall tasks'
  );
  assert.equal(
    isInstalledPackageContext({
      cwd: workspaceJunction,
      realpathSync: () => workspaceJunction,
    }),
    true,
    'a genuine installed package must continue to skip repository-only postinstall tasks'
  );

  const spawnCalls = [];
  const uiWorkspace = join(repoRoot, 'apps', 'ui');
  const status = runUiPostinstall({
    cwd: workspaceJunction,
    env: {
      HAPPIER_INSTALL_SCOPE: 'ui,protocol',
      npm_execpath: 'D:\\hostedtoolcache\\pnpm.exe',
    },
    execPath: 'C:\\hostedtoolcache\\node.exe',
    platform: 'win32',
    realpathSync: () => uiWorkspace,
    spawnSync: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(spawnCalls, [{
    command: 'D:\\hostedtoolcache\\pnpm.exe',
    args: ['--silent', 'run', 'postinstall:real'],
    options: {
      cwd: uiWorkspace,
      env: {
        HAPPIER_INSTALL_SCOPE: 'ui,protocol',
        npm_execpath: 'D:\\hostedtoolcache\\pnpm.exe',
      },
      stdio: 'inherit',
    },
  }]);
});

test('ui postinstall runner skips installed package context and respects npm_execpath', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  const postinstallScript = String(uiPackageJson?.scripts?.postinstall ?? '');
  const runnerSource = await readFile(uiPostinstallRunnerPath, 'utf8');
  assert.equal(
    postinstallScript,
    'node ./tools/postinstall/runUiPostinstall.cjs',
    'apps/ui package.json should delegate postinstall ownership to the testable runner'
  );
  assert.match(
    runnerSource,
    /node_modules/i,
    'postinstall should no-op inside node_modules installs'
  );
  assert.match(
    runnerSource,
    /realpathSync/,
    'postinstall should resolve workspace junctions before classifying installed package context'
  );
  assert.match(
    runnerSource,
    /npm_execpath/,
    'postinstall should prefer npm_execpath when available'
  );
  assert.match(
    runnerSource,
    /resolvePnpmCommandInvocation/,
    'postinstall should use the canonical native-aware invocation owner'
  );
  assert.match(
    runnerSource,
    /result\.error/,
    'postinstall should surface spawn errors explicitly'
  );
  assert.match(
    runnerSource,
    /postinstall:real/,
    'postinstall runner should continue to delegate to postinstall:real'
  );
});

test('ui postinstall invokes the Skia setup CLI without a package-manager shim', async () => {
  const postinstallSource = await readFile(uiPostinstallPath, 'utf8');

  assert.doesNotMatch(
    postinstallSource,
    /command:\s*['"]npx['"]/,
    'shell-free Windows spawns cannot resolve the npx.cmd shim',
  );
  assert.match(
    postinstallSource,
    /@shopify['"],\s*['"]react-native-skia['"],\s*['"]scripts['"],\s*['"]setup-canvaskit\.js['"]/,
    'postinstall should resolve the Skia-owned CLI script from the installed package',
  );
  assert.match(
    postinstallSource,
    /command:\s*process\.execPath/,
    'postinstall should invoke the JavaScript CLI through the current Node runtime',
  );
});

test('ui Metro/Babel runtime owns babel-plugin-module-resolver as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-module-resolver'],
    '^5.0.2',
    'apps/ui Metro bundling requires babel-plugin-module-resolver during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-module-resolver'],
    undefined,
    'apps/ui should not keep babel-plugin-module-resolver in devDependencies once production bundling depends on it'
  );
});

test('ui production Metro/Babel runtime owns babel-plugin-transform-remove-console as an install-time dependency', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));

  assert.equal(
    uiPackageJson?.dependencies?.['babel-plugin-transform-remove-console'],
    '^6.9.4',
    'apps/ui production Metro bundling requires babel-plugin-transform-remove-console during EAS/local builds, so it must live in dependencies'
  );
  assert.equal(
    uiPackageJson?.devDependencies?.['babel-plugin-transform-remove-console'],
    undefined,
    'apps/ui should not keep babel-plugin-transform-remove-console in devDependencies once production bundling depends on it'
  );
});
