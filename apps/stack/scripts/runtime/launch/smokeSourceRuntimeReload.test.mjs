import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSourceRuntimeBundle } from '../../build/build_source_runtime.mjs';
import { runCaptureResult } from '../../utils/proc/proc.mjs';
import { smokeSourceRuntimeReload } from './smokeSourceRuntimeReload.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

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

test('PostgreSQL import smoke loads the replacement and rejects module failures without retained database access', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-postgres-import-smoke-' });
  const witness = fixture.path('imported');
  const server = await createServerFixture(fixture.root, 'postgres', witness);
  await writeFile(server.entrypoint, `
    import {writeFileSync} from 'node:fs';
    if (!process.argv.includes('--probe-runtime-import')) throw new Error('boot would open the database');
    if (process.env.DATABASE_URL || process.env.HANDY_MASTER_SECRET || process.env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE) throw new Error('retained database authority leaked');
    if (!process.env.HAPPIER_SERVER_LIGHT_DATA_DIR.includes('hstack-reload-smoke-')) throw new Error('data directory not isolated');
    writeFileSync(${JSON.stringify(witness)}, 'loaded');
  `);
  const env = { ...process.env, DATABASE_URL: 'postgresql://retained.invalid/live', HANDY_MASTER_SECRET: 'retained-secret',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('retained.env'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: fixture.path('retained-data') };
  await smokeSourceRuntimeReload({ components: { server }, env, logger: { log() {} } });
  assert.equal(await readFile(witness, 'utf8'), 'loaded');
  await writeFile(server.entrypoint, 'throw new TypeError("replacement-schema.optional is not a function");');
  await assert.rejects(smokeSourceRuntimeReload({ components: { server }, env, logger: { log() {} } }),
    /replacement-schema.optional is not a function/);
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
  assert.notEqual(emittedMigration.exitCode, 0);
  assert.match(emittedMigration.err, /schema\.prisma:[0-9]+|environment variable `DATABASE_URL` resolved to an empty string/i);

  // Reach the real light entry and its lazy server graph, not the shallow
  // capability probe. A successful probe must stop before database startup.
  const imported = await runCaptureResult(process.execPath, [server.entrypoint, '--probe-runtime-import'], {
    cwd: server.serverDir,
    env: { ...process.env, ...server.env, DATABASE_URL: '', HANDY_MASTER_SECRET: '',
      HAPPIER_SERVER_LIGHT_DATA_DIR: join(root, 'probe-data') },
  });
  assert.equal(imported.exitCode, 0, imported.err);
  await assert.rejects(access(join(root, 'probe-data')), { code: 'ENOENT' });

  const witness = join(root, 'smoke-processes');
  const observer = join(root, 'observe-smoke.mjs');
  await writeFile(observer, `import {writeFileSync} from 'node:fs';
    if(process.argv.includes('--probe-runtime-import')) process.once('exit', () => writeFileSync(${JSON.stringify(witness)}, JSON.stringify({
      entry:process.argv[1],provider:process.env.HAPPIER_DB_PROVIDER,dataDir:process.env.HAPPIER_SERVER_LIGHT_DATA_DIR,
      databaseUrl:process.env.DATABASE_URL,masterSecret:process.env.HANDY_MASTER_SECRET})));`);
  const retainedEnv = join(root, 'retained.env');
  await writeFile(retainedEnv, [
    'DATABASE_URL=postgresql://retained.invalid/live',
    'HANDY_MASTER_SECRET=retained-fixture-secret',
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${join(root, 'retained-data')}`,
  ].join('\n'));
  const logs = [];
  await smokeSourceRuntimeReload({
    components: { server },
    env: {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      DATABASE_URL: 'postgresql://retained.invalid/live',
      DOTENV_CONFIG_PATH: retainedEnv,
      DOTENV_CONFIG_OVERRIDE: 'true',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim(),
    },
    logger: { log: message => logs.push(message) },
  });
  assert.match(logs.join('\n'), /skipping its database-backed migration and health smoke because the shared DATABASE_URL is forbidden/);
  const observation = JSON.parse((await readFile(witness, 'utf8')).trim());
  assert.equal(observation.entry, server.entrypoint);
  assert.equal(observation.provider, 'postgres');
  assert.equal(observation.databaseUrl, '');
  assert.equal(observation.masterSecret, '');
  assert.ok(observation.dataDir.includes('hstack-reload-smoke-'));
});

test('source reload isolates its health smoke on loopback despite inherited server exposure', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-smoke-listen-host-' });
  const witness = fixture.path('listen-host');
  const server = await createServerFixture(fixture.root, 'sqlite', witness);
  await writeFile(server.entrypoint, `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    const http = createServer((_request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
    });
    http.listen(Number(process.env.PORT), process.env.HAPPIER_SERVER_HOST ?? '0.0.0.0', () => {
      writeFileSync(${JSON.stringify(witness)}, http.address().address);
    });
  `);
  await smokeSourceRuntimeReload({ components: { server },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_SERVER_HOST: '0.0.0.0',
      HAPPY_SERVER_HOST: '0.0.0.0' } });
  assert.equal(await readFile(witness, 'utf8'), '127.0.0.1');
});
