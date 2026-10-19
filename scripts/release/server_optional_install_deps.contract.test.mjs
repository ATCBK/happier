import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverPackagePath = join(repoRoot, 'apps', 'server', 'package.json');

test('developer installs defer Redis acquisition while validation still acquires it on demand', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const require = createRequire(serverPackagePath);
  const postinstall = require.resolve('redis-memory-server/scripts/postinstall.js');
  const redisEntry = require.resolve('redis-memory-server');
  const fixture = await mkdtemp(join(tmpdir(), 'happier-redis-install-'));
  try {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ redisMemoryServer: manifest.redisMemoryServer }));
    const serverDirectory = join(fixture, 'apps/server');
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(join(serverDirectory, 'package.json'), JSON.stringify({ name: 'server' }));
    const env = { ...process.env, REDISMS_DOWNLOAD_DIR: join(fixture, 'redis'), REDISMS_VERSION: 'missing-install-probe', REDISMS_DOWNLOAD_URL: 'not-a-valid-url' };
    delete env.REDISMS_DISABLE_POSTINSTALL;
    delete env.REDISMS_SYSTEM_BINARY;
    for (const cwd of [fixture, serverDirectory]) {
      const install = spawnSync(process.execPath, [postinstall], { cwd, env: { ...env, INIT_CWD: cwd }, encoding: 'utf8' });
      assert.equal(install.status, 0, install.stdout + install.stderr);
    }
    const runtime = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).RedisMemoryServer.create().then(async instance => { await instance.getIp(); await instance.stop(); }).catch(error => { console.error(error); process.exitCode = 1; });', redisEntry], { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(runtime.status, 1, runtime.stdout + runtime.stderr);
    assert.match(runtime.stdout + runtime.stderr, /Provided incorrect download url/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
