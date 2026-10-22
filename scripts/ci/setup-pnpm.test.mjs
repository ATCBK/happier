import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const setupPath = fileURLToPath(new URL('./setup-pnpm.mjs', import.meta.url));

async function fixture(t, { corrupt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = 'fixture package archive';
  const digest = createHash('sha512').update(corrupt ? 'other archive' : payload).digest('hex');
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: `pnpm@12.14.0+sha512.${digest}` }));
  // npm and pnpm are external process boundaries. The archive contents need not
  // be an npm package: this test protects admission before the real npm install.
  const npmPath = join(root, 'npm-cli.js');
  await writeFile(npmPath, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify(args) + '\\n');
    if (args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const filename = 'pnpm-12.14.0.tgz';
      fs.writeFileSync(path.join(destination, filename), ${JSON.stringify(payload)});
      console.log(JSON.stringify([{ filename }]));
    } else if (args[0] === 'install') {
      if (process.env.SETUP_TEST_LIVE_PREREQUISITE) fs.rmSync(process.env.SETUP_TEST_LIVE_PREREQUISITE, { force: true });
      fs.writeFileSync(process.env.SETUP_TEST_INSTALLED, 'ready');
    }
    else process.exit(2);
  `);
  const pnpmPath = join(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  await writeFile(pnpmPath, process.platform === 'win32'
    ? '@echo off\r\nif not exist "%SETUP_TEST_INSTALLED%" exit /b 1\r\necho 12.14.0\r\n'
    : '#!/bin/sh\n[ -f "$SETUP_TEST_INSTALLED" ] || exit 1\nprintf "12.14.0\\n"\n');
  await chmod(pnpmPath, 0o755);
  return { root, env: { ...process.env, npm_execpath: npmPath, PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    HAPPIER_STACK_HOME_DIR: root, SETUP_TEST_CALLS: join(root, 'calls'), SETUP_TEST_INSTALLED: join(root, 'installed') } };
}

test('setup installs the exact integrity-checked root pin without Corepack', async (t) => {
  const { root, env } = await fixture(t);
  execFileSync(process.execPath, [setupPath, root], { env });
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].includes('pnpm@12.14.0'));
  assert.ok(calls[0].includes('--ignore-scripts'));
  assert.equal(calls[1][0], 'install');
  assert.ok(calls[1].includes('--global'));
  assert.match(calls[1].at(-1), /pnpm-12\.14\.0\.tgz$/);
});

test('setup rejects a mismatched archive before global installation', async (t) => {
  const { root, env } = await fixture(t, { corrupt: true });
  assert.throws(() => execFileSync(process.execPath, [setupPath, root], { env, stdio: 'pipe' }), /integrity mismatch/);
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(([command]) => command), ['pack']);
});

test('repeated setup verifies the pin without replacing a live matching package manager', async t => {
  const { root, env } = await fixture(t);
  env.SETUP_TEST_LIVE_PREREQUISITE = join(root, 'live-node-gyp');
  execFileSync(process.execPath, [setupPath, root], { env });
  await writeFile(env.SETUP_TEST_LIVE_PREREQUISITE, 'in-use native build payload');
  execFileSync(process.execPath, [setupPath, root], { env });
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(([command]) => command === 'pack').length, 2,
    'every setup must continue checking the archive against the root integrity pin');
  assert.equal(await readFile(env.SETUP_TEST_LIVE_PREREQUISITE, 'utf8'), 'in-use native build payload',
    'setup must preserve the matching package manager payload used by dependency scripts');
});
