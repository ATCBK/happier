import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { smokeSourceRuntimeReload } from './smokeSourceRuntimeReload.mjs';

const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));

async function createServerFixture(root, provider, witness) {
  const serverDir = join(root, 'candidate', 'apps', 'server');
  const entrypoint = join(serverDir, 'sources', 'main.mjs');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await writeFile(entrypoint, `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    const provider = process.env.HAPPIER_DB_PROVIDER;
    if (provider === 'sqlite' && !process.env.DATABASE_URL.startsWith('file:')) throw new Error('wrong sqlite scratch database');
    if (provider === 'pglite' && !process.env.HAPPIER_SERVER_LIGHT_DB_DIR.endsWith('/pglite')) throw new Error('wrong pglite scratch database');
    writeFileSync(${JSON.stringify(witness)}, provider);
    createServer((_request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
    }).listen(Number(process.env.PORT),'127.0.0.1');
  `);
  return {
    identity: `${provider}-candidate`,
    runtimeDir: serverDir,
    serverDir,
    entrypoint,
    serverComponent: 'happier-server-light',
    dbProvider: provider,
    env: { HAPPIER_DB_PROVIDER: provider },
    migration: { mode: 'disabled' },
  };
}

test('source reload probes Postgres-shaped server code on isolated pglite scratch data', async (t) => {
  for (const [provider, expectedSmokeProvider] of [['sqlite', 'sqlite'], ['pglite', 'pglite'], ['postgres', 'pglite']]) {
    const root = await mkdtemp(join(tmpdir(), `hstack-reload-smoke-${provider}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const witness = join(root, 'observed-provider');
    const server = await createServerFixture(root, provider, witness);
    await smokeSourceRuntimeReload({ components: { server },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir,
        DATABASE_URL: 'postgresql://retained.invalid/live', HAPPIER_DB_PROVIDER: 'postgres' } });
    assert.equal(await readFile(witness, 'utf8'), expectedSmokeProvider);
  }

  const root = await mkdtemp(join(tmpdir(), 'hstack-reload-smoke-unsupported-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const witness = join(root, 'observed-provider');
  await assert.rejects(smokeSourceRuntimeReload({
      components: { server: await createServerFixture(root, 'mysql', witness) },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } }),
    /cannot smoke mysql without a separately authorized scratch database/);
  await assert.rejects(access(witness), { code: 'ENOENT' });
});
