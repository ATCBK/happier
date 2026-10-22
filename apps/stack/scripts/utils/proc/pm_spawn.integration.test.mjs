import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pmSpawnBin, pmSpawnScript } from './pm.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function waitExit(child) {
  return await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function writeStubPnpm({ binDir, expectedCommand }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      // ensurePnpmReady calls: pnpm --version
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      // Scripts use pnpm run; binaries use pnpm exec.
      `process.exit(args[0] === ${JSON.stringify(expectedCommand)} ? 0 : 79);`,
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

async function writeStubPnpmCaptureKind({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const args = process.argv.slice(2);',
      // ensurePnpmReady calls: pnpm --version
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      // Scripts use pnpm run; binaries use pnpm exec.
      'if (args[0] === "run") {',
      '  const out = process.env.TEST_OUT_FILE || "";',
      '  if (out) fs.writeFileSync(out, String(process.env.HAPPIER_STACK_PROCESS_KIND || ""), "utf-8");',
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

async function writeStubPnpmCaptureEnv({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const out = process.env.TEST_OUT_FILE || "";',
      '  if (out) {',
      '    fs.writeFileSync(out, JSON.stringify({ TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH || "" }), "utf-8");',
      '  }',
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

async function writeStubPnpmUsesTsx({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      'const { spawnSync } = require("node:child_process");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const result = spawnSync("tsx", ["./scripts/dev.light.ts"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

async function writeStubPnpmUsesShellTool({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      'const { spawnSync } = require("node:child_process");',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('12.14.0'); process.exit(0); }",
      'if (args[0] === "run") {',
      '  const result = spawnSync("shell-tool", ["--ping"], { cwd: process.cwd(), env: process.env, stdio: "inherit" });',
      '  if (result.error) throw result.error;',
      '  process.exit(result.status ?? 0);',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pnpmPath, 0o755);
}

test('pmSpawnScript launches package scripts through pnpm run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-script-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(componentDir, 'pnpm-workspace.yaml'), "packages:\n");

  const binDir = join(root, 'bin');
  await writeStubPnpm({ binDir, expectedCommand: 'run' });

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnBin launches installed binaries through pnpm exec', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-bin-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(componentDir, 'pnpm-workspace.yaml'), "packages:\n");

  const binDir = join(root, 'bin');
  await writeStubPnpm({ binDir, expectedCommand: 'exec' });

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  const child = await pmSpawnBin({ dir: componentDir, label: 'spawn-test', bin: 'prisma', args: ['generate'], env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnScript marks stack-owned infra processes with HAPPIER_STACK_PROCESS_KIND=infra', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-kind-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(componentDir, 'pnpm-workspace.yaml'), "packages:\n");

  const outFile = join(root, 'kind.txt');

  const binDir = join(root, 'bin');
  await writeStubPnpmCaptureKind({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TEST_OUT_FILE: outFile,
    HAPPIER_STACK_STACK: 'k',
    HAPPIER_STACK_ENV_FILE: join(root, 'stack-env'),
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const kind = (await readFile(outFile, 'utf-8')).trim();
  assert.equal(kind, 'infra');
});

test('pmSpawnScript treats stack-owned package-manager children as infra even when caller inherited a session kind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-kind-session-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(componentDir, 'pnpm-workspace.yaml'), "packages:\n");

  const outFile = join(root, 'kind.txt');

  const binDir = join(root, 'bin');
  await writeStubPnpmCaptureKind({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TEST_OUT_FILE: outFile,
    HAPPIER_STACK_STACK: 'k',
    HAPPIER_STACK_ENV_FILE: join(root, 'stack-env'),
    HAPPIER_STACK_PROCESS_KIND: 'session',
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const kind = (await readFile(outFile, 'utf-8')).trim();
  assert.equal(kind, 'infra');
});

test('pmSpawnScript scopes TSX_TSCONFIG_PATH to the component tsconfig', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-tsx-tsconfig-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(componentDir, 'pnpm-workspace.yaml'), "packages:\n");
  await writeFile(join(componentDir, 'tsconfig.json'), '{ "compilerOptions": {} }\n', 'utf-8');

  const outFile = join(root, 'tsx-env.json');
  const binDir = join(root, 'bin');
  await writeStubPnpmCaptureEnv({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TEST_OUT_FILE: outFile,
    TSX_TSCONFIG_PATH: '/tmp/foreign-component/tsconfig.json',
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'noop', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);

  const captured = JSON.parse(await readFile(outFile, 'utf-8'));
  assert.equal(captured.TSX_TSCONFIG_PATH, join(componentDir, 'tsconfig.json'));
});

test('pmSpawnScript resolves tsx package bins when repo root node_modules/.bin is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-tsx-shim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'server');
  await mkdir(join(componentDir, 'scripts'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n");
  await writeJson(join(componentDir, 'package.json'), { name: '@happier-dev/server', version: '0.0.0' });
  await writeFile(join(componentDir, 'scripts', 'dev.light.ts'), 'export {};\n', 'utf-8');

  const tsxDir = join(root, 'node_modules', 'tsx');
  await mkdir(join(tsxDir, 'dist'), { recursive: true });
  await writeJson(join(tsxDir, 'package.json'), {
    name: 'tsx',
    version: '4.20.4',
    bin: {
      tsx: './dist/cli.mjs',
    },
  });
  await writeFile(
    join(tsxDir, 'dist', 'cli.mjs'),
    [
      '#!/usr/bin/env node',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(tsxDir, 'dist', 'cli.mjs'), 0o755);

  const binDir = join(root, 'bin');
  await writeStubPnpmUsesTsx({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_ENV_FILE: null,
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'dev:light', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});

test('pmSpawnScript resolves shell-script package bins without forcing them through node', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-spawn-shell-tool-shim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'server');
  await mkdir(join(componentDir, 'scripts'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'pnpm-lock.yaml'), '# pnpm\n', 'utf-8');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n");
  await writeJson(join(componentDir, 'package.json'), {
    name: '@happier-dev/server',
    version: '0.0.0',
    dependencies: {
      'shell-tool-package': '1.0.0',
    },
  });
  await writeFile(join(componentDir, 'scripts', 'dev.light.ts'), 'export {};\n', 'utf-8');

  const shellToolDir = join(root, 'node_modules', 'shell-tool-package');
  await mkdir(join(shellToolDir, 'dist'), { recursive: true });
  await writeJson(join(shellToolDir, 'package.json'), {
    name: 'shell-tool-package',
    version: '1.0.0',
    bin: {
      'shell-tool': './dist/cli.sh',
    },
  });
  await writeFile(
    join(shellToolDir, 'dist', 'cli.sh'),
    [
      '#!/bin/sh',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(join(shellToolDir, 'dist', 'cli.sh'), 0o755);

  const binDir = join(root, 'bin');
  await writeStubPnpmUsesShellTool({ binDir });

  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_ENV_FILE: null,
  };
  const child = await pmSpawnScript({ dir: componentDir, label: 'spawn-test', script: 'dev:light', env, quiet: true, options: { silent: true } });
  const res = await waitExit(child);
  assert.equal(res.code, 0);
});
