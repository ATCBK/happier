import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('happier wrapper skips bundled workspace preflight when disabled', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-wrapper-bootstrap-disabled-'));
  try {
    const syncMarkerPath = join(fixtureDir, 'sync.txt');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const cliStubPath = join(fixtureDir, 'happier.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(syncMarkerPath)}, 'imported', 'utf8');`,
        'export async function bundleWorkspaceDeps() {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(cliStubPath, "process.stdout.write('wrapper-ran\\n');\n", 'utf8');
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/happier.mjs' || specifier === '../scripts/happier_main.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(cliStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await runNodeCapture([join(rootDir, 'bin', 'happier.mjs')], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), false);
    assert.match(res.stdout, /wrapper-ran/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('happier wrapper keeps metadata-only help read-only without bundled workspace preflight', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-wrapper-bootstrap-help-'));
  try {
    const syncMarkerPath = join(fixtureDir, 'bundle-imported.txt');
    const bundleStubPath = join(fixtureDir, 'bundleWorkspaceDeps.mjs');
    const cliStubPath = join(fixtureDir, 'happier.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      bundleStubPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(syncMarkerPath)}, 'imported', 'utf8');`,
        'export async function bundleWorkspaceDeps() {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(cliStubPath, "process.stdout.write('cli-help-ran\\n');\n", 'utf8');
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === '../scripts/bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(bundleStubPath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === '../scripts/happier.mjs' || specifier === '../scripts/happier_main.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(cliStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await runNodeCapture([join(rootDir, 'bin', 'happier.mjs'), '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), false, 'metadata-only help must not publish bundled workspace packages');
    assert.match(res.stdout, /cli-help-ran/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('happier script loads the main CLI entrypoint without bundle preflight', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-script-bootstrap-'));
  try {
    const syncMarkerPath = join(fixtureDir, 'bundle-imported.txt');
    const cliMarkerPath = join(fixtureDir, 'cli.txt');
    const syncModulePath = join(fixtureDir, 'syncBundledWorkspacePackages.mjs');
    const cliStubPath = join(fixtureDir, 'happier_main.mjs');
    const loaderPath = join(fixtureDir, 'loader.mjs');

    writeFileSync(
      syncModulePath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(syncMarkerPath)}, 'imported', 'utf8');`,
        'export async function bundleWorkspaceDeps() {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      cliStubPath,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(cliMarkerPath)}, 'happier\\n', 'utf8');`,
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      loaderPath,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        'export async function resolve(specifier, context, defaultResolve) {',
        "  if (specifier === './bundleWorkspaceDeps.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(syncModulePath)}).href, shortCircuit: true };`,
        '  }',
        "  if (specifier === './happier_main.mjs') {",
        `    return { url: pathToFileURL(${JSON.stringify(cliStubPath)}).href, shortCircuit: true };`,
        '  }',
        '  return defaultResolve(specifier, context, defaultResolve);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await runNodeCapture([join(rootDir, 'scripts', 'happier.mjs'), '--help'], {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
      },
    });

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.equal(existsSync(syncMarkerPath), false, 'expected scripts/happier.mjs to skip bundle preflight');
    const cliMarker = readFileSync(cliMarkerPath, 'utf8');
    assert.equal(cliMarker, 'happier\n');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
