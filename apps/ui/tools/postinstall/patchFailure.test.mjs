import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPnpmPatches } from './pnpmPatches.mjs';
import {
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES,
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS,
} from './verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';

test('UI postinstall verifies installed artifacts without patch-package and finds the pnpm root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-installed-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ui = join(root, 'apps/ui');
  await mkdir(ui, { recursive: true });
  await cp(new URL('../', import.meta.url), join(ui, 'tools'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'patchedDependencies: {}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(join(ui, 'package.json'), '{"name":"@happier-dev/app"}\n');
  await writeFile(join(ui, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const require = createRequire(import.meta.url);
  for (const name of ['esbuild', 'diff', 'yaml']) {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(dirname(require.resolve(`${name}/package.json`)), join(root, 'node_modules', name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const packageDir = join(root, 'node_modules/react-native-enriched-markdown');
  for (const file of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
    await mkdir(dirname(join(packageDir, file)), { recursive: true });
    const markers = REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS
      .filter(([name]) => name === file)
      .flatMap(([, marker, count = 1]) => Array(count).fill(marker));
    await writeFile(join(packageDir, file), markers.join('\n'));
  }
  await writeFile(join(packageDir, 'package.json'), '{"name":"react-native-enriched-markdown"}\n');
  const result = spawnSync(process.execPath, [join(ui, 'tools/postinstall.mjs')], {
    cwd: ui, encoding: 'utf8', env: { ...process.env, HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
      HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Could not find @sentry\/react-native iOS native start source/);
  assert.doesNotMatch(result.stderr, /patch-package CLI/);

  const sentrySource = join(root, 'apps/node_modules/@sentry/react-native/ios/RNSentryStart.m');
  await mkdir(dirname(sentrySource), { recursive: true });
  await writeFile(sentrySource, '// unpatched native source\n');
  await writeFile(join(root, 'apps/node_modules/@sentry/react-native/package.json'), '{"name":"@sentry/react-native"}\n');
  const ancestorResult = spawnSync(process.execPath, [join(ui, 'tools/postinstall.mjs')], {
    cwd: ui, encoding: 'utf8', env: { ...process.env, HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
      HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1' },
  });
  assert.equal(ancestorResult.status, 1, ancestorResult.stderr);
  assert.ok(ancestorResult.stderr.includes(sentrySource), ancestorResult.stderr);
});

test('pnpm patches check out with LF endings so Windows installs apply them byte-for-byte', t => {
  // pnpm copies patch line endings into node_modules; a CRLF checkout leaves
  // mixed-EOL patched files that the installed-artifact preflight rejects.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const inWorkTree = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inWorkTree.status !== 0) return t.skip('requires a Git work tree to resolve .gitattributes');
  const patchFiles = readPnpmPatches(repoRoot).map(({ patchFile }) => relative(repoRoot, patchFile).replaceAll('\\', '/'));
  assert.ok(patchFiles.length > 0);
  const result = spawnSync('git', ['-C', repoRoot, 'check-attr', 'eol', '--', ...patchFiles], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const unpinned = result.stdout.trim().split('\n').filter(line => !line.endsWith(': eol: lf'));
  assert.deepEqual(unpinned, []);
});
