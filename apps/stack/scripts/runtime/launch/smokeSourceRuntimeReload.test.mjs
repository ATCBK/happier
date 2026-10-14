import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSourceRuntimeBundle } from '../../build/build_source_runtime.mjs';
import { runCaptureResult } from '../../utils/proc/proc.mjs';
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

test('source reload probes local database server code on isolated scratch data', async (t) => {
  for (const provider of ['sqlite', 'pglite']) {
    const root = await mkdtemp(join(tmpdir(), `hstack-reload-smoke-${provider}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const witness = join(root, 'observed-provider');
    const server = await createServerFixture(root, provider, witness);
    await smokeSourceRuntimeReload({ components: { server },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir,
        DATABASE_URL: 'postgresql://retained.invalid/live', HAPPIER_DB_PROVIDER: 'postgres' } });
    assert.equal(await readFile(witness, 'utf8'), provider);
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
test('source reload recognizes the real emitted PostgreSQL graph and skips only its database-backed probe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-reload-smoke-real-postgres-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await buildSourceRuntimeBundle({
    repoDir,
    outputDir: join(root, 'runtime'),
    component: 'server',
    serverComponent: 'happier-server-light',
    dbProvider: 'postgres',
    env: process.env,
  });
  const emittedMigration = await runCaptureResult(process.execPath, [server.migration.command], {
    cwd: server.migration.cwd,
    env: {
      ...process.env,
      ...server.env,
      HAPPIER_DB_PROVIDER: 'pglite',
      DATABASE_URL: '',
    },
  });
  assert.notEqual(emittedMigration.code, 0);
  assert.match(emittedMigration.err, /schema\.prisma:[0-9]+|environment variable `DATABASE_URL` resolved to an empty string/i);

  const witness = join(root, 'smoke-processes');
  const observer = join(root, 'observe-smoke.mjs');
  await writeFile(observer, `import {appendFileSync} from 'node:fs';
    if(process.env.HAPPIER_DB_PROVIDER==='pglite') appendFileSync(${JSON.stringify(witness)}, JSON.stringify({
      entry:process.argv[1],provider:process.env.HAPPIER_DB_PROVIDER,dataDir:process.env.HAPPIER_SERVER_LIGHT_DATA_DIR,
      databaseUrl:process.env.DATABASE_URL})+'\\n');`);
  const logs = [];
  await smokeSourceRuntimeReload({
    components: { server },
    env: {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      DATABASE_URL: 'postgresql://retained.invalid/live',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim(),
    },
    logger: { log: message => logs.push(message) },
  });
  assert.match(logs.join('\n'), /skipping its database-backed migration and health smoke because the shared DATABASE_URL is forbidden/);
  await assert.rejects(access(witness), { code: 'ENOENT' });
});
