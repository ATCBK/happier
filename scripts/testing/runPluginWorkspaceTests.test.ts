import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPluginWorkspaceTests } from './runPluginWorkspaceTests.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeWorkerEnvKeys = ['VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS'];

interface FixtureEvent {
  kind: string;
  project: string;
  pid?: number;
  maxWorkers?: number;
  maxForks?: number;
  maxThreads?: number;
  minForks?: number;
  minThreads?: number;
  poolEnv?: NodeJS.ProcessEnv;
  before?: NodeJS.ProcessEnv;
  after?: NodeJS.ProcessEnv;
}

async function createProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-vitest-projects-'));
  const eventsPath = join(root, 'events.jsonl');
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/plugins/*', 'apps/*'] }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/plugins/*\n  - apps/*\nverifyDepsBeforeRun: false\n');
  await writeFile(join(root, 'vitest.config.ts'), 'export default { test: { environment: "node" } };');
  await writeFile(join(root, 'hook.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({kind:process.argv[2],project:process.argv[3],poolEnv:Object.fromEntries(${JSON.stringify(nativeWorkerEnvKeys)}.map(key=>[key,process.env[key]]))})+'\\n');
if(process.argv[2]==='checks' && process.env.FAIL_ADJUNCT===process.argv[3]) process.exitCode=7;`);
  // The real runner adds its cwd setup from outside the temporary workspace.
  const sharedCwdSetup = join(repositoryRoot, 'scripts/testing/vitestProjectCwd.mjs');
  for (const name of ['alpha', 'beta']) {
    const packageRoot = join(root, 'packages/plugins', name);
    await mkdir(packageRoot, { recursive: true });
    const vitestPath = join(repositoryRoot, 'node_modules/vitest/vitest.mjs');
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: `@fixture/${name}`, version: '0.0.0', type: 'module', scripts: {
        test: `pnpm --silent run test:unit:prepare && node ${JSON.stringify(vitestPath)} run && pnpm --silent run test:unit:checks`,
        typecheck: 'node -e ""',
        'test:unit:prepare': `node ../../../hook.mjs prepare ${name}`,
        'test:unit:checks': `node ../../../hook.mjs checks ${name}`,
      },
    }));
    await writeFile(join(packageRoot, 'value.ts'), `export default ${JSON.stringify(name)};`);
    await writeFile(join(packageRoot, 'vitest.config.ts'), `import { fileURLToPath } from 'node:url';
if(process.env.FAIL_CONFIG) throw new Error('fixture configuration startup failed');
export default {resolve:{alias:{'fixture-value':fileURLToPath(new URL('./value.ts',import.meta.url))}},
server:{fs:{allow:[${JSON.stringify(root)},${JSON.stringify(sharedCwdSetup)}]}},
test:{name:${JSON.stringify(name)},include:['selected.test.ts'],exclude:['excluded.test.ts'],env:{FIXTURE_CONFIG:${JSON.stringify(name)}},setupFiles:['./setup.ts'],globalSetup:['./global.ts']}};`);
    await writeFile(join(packageRoot, 'global.ts'), `import {appendFileSync} from 'node:fs';
export default function(project){const config=project.vitest.config;appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'global',project:${JSON.stringify(name)},pid:process.pid,maxWorkers:config.maxWorkers,maxForks:config.poolOptions?.forks?.maxForks,maxThreads:config.poolOptions?.threads?.maxThreads,minForks:config.poolOptions?.forks?.minForks,minThreads:config.poolOptions?.threads?.minThreads})+'\\n');return()=>{if(process.env.FAIL_CLOSE===${JSON.stringify(name)}){appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'close',project:${JSON.stringify(name)}})+'\\n');throw new Error('fixture global teardown failed');}};}`);
    await writeFile(join(packageRoot, 'setup.ts'), `import assert from 'node:assert/strict';
import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';
assert.equal(process.cwd(),dirname(fileURLToPath(import.meta.url)));
assert.equal(process.env.FIXTURE_CONFIG,${JSON.stringify(name)});process.env.FIXTURE_SETUP=${JSON.stringify(name)};`);
    await writeFile(join(packageRoot, 'selected.test.ts'), `import {test,expect} from 'vitest';import value from 'fixture-value';
import {appendFileSync} from 'node:fs';test('real selected project',()=>{
expect(value).toBe(${JSON.stringify(name)});expect(process.env.FIXTURE_SETUP).toBe(value);
appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'test',project:value})+'\\n');
expect(process.env.FAIL_PROJECT).not.toBe(value);});`);
    await writeFile(join(packageRoot, 'excluded.test.ts'), 'throw new Error("excluded package test executed");');
  }
  const unselectedRoot = join(root, 'apps/cli');
  await mkdir(unselectedRoot, { recursive: true });
  await writeFile(join(unselectedRoot, 'package.json'), JSON.stringify({ name: '@fixture/cli', scripts: { test: 'node -e "process.exit(8)"' } }));
  await writeFile(join(unselectedRoot, 'unselected.test.ts'), 'throw new Error("unselected workspace executed");');
  return { root, eventsPath };
}

async function runFixture(env: NodeJS.ProcessEnv = {}, options: { gate?: boolean; observeEnv?: boolean } = {}) {
  const fixture = await createProjectFixture();
  let runner = join(repositoryRoot, 'scripts/testing', options.gate ? 'runRootTests.ts' : 'runPluginWorkspaceTests.ts');
  if (options.observeEnv) {
    const owner = runner;
    runner = join(fixture.root, 'observe-env.mjs');
    await writeFile(runner, `import {appendFileSync} from 'node:fs';import {runRootTests} from ${JSON.stringify(pathToFileURL(owner).href)};
const read=()=>Object.fromEntries(${JSON.stringify(nativeWorkerEnvKeys)}.map(key=>[key,process.env[key]]));const before=read();
try{await runRootTests('gate-unit',['plugins']);}catch(error){console.error(error);process.exitCode=1;}finally{appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify({kind:'environment',project:'caller',before,after:read()})+'\\n');}`);
  }
  const result = await new Promise<{ code: number | null; output: string }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', runner, ...(options.gate && !options.observeEnv ? ['gate-unit', 'plugins'] : [])], {
      cwd: fixture.root,
      env: { ...process.env, HAPPIER_VITEST_MAX_WORKERS: '2', FIXTURE_EVENTS: fixture.eventsPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', rejectRun);
    child.once('exit', (code) => resolveRun({ code, output }));
  });
  try {
    // Records are emitted by this fixture's real child processes.
    const events = (await readFile(fixture.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as FixtureEvent);
    return { ...result, events };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('selected plugin projects share one Vitest instance and preserve package setup/config and adjuncts', async () => {
  const result = await runFixture({ VITEST_MAX_FORKS: '13', VITEST_MAX_THREADS: '13', VITEST_MIN_FORKS: '1', VITEST_MIN_THREADS: '1' });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.events.filter((event) => event.kind === 'test').map((event) => event.project).sort(), ['alpha', 'beta']);
  assert.equal(new Set(result.events.filter((event) => event.kind === 'global').map((event) => event.pid)).size, 1);
  for (const global of result.events.filter((event) => event.kind === 'global')) {
    assert.equal(global.maxWorkers, 2);
    assert.equal(global.maxForks, 2, 'the native fork pool must use the canonical budget');
    assert.equal(global.maxThreads, 2);
    assert.equal(global.minForks, 1);
    assert.equal(global.minThreads, 1);
  }
  for (const project of ['alpha', 'beta']) {
    const kinds = result.events.filter((event) => event.project === project).map((event) => event.kind);
    assert.deepEqual(kinds, ['prepare', 'global', 'test', 'checks']);
  }
});

test('project failure remains red while successful selected projects and their adjuncts complete', async () => {
  const result = await runFixture({ FAIL_PROJECT: 'alpha' });
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(result.events.filter((event) => event.kind === 'test').map((event) => event.project).sort(), ['alpha', 'beta']);
  assert.deepEqual(result.events.filter((event) => event.kind === 'checks').map((event) => event.project), ['beta']);
});

test('package-owned adjunct failure fails the composed lane after real Vitest succeeds', async () => {
  const result = await runFixture({ FAIL_ADJUNCT: 'alpha' });
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(result.events.filter((event) => event.kind === 'checks').map((event) => event.project).sort(), ['alpha', 'beta']);
});

test('public Gate selection uses the same projects and does not run an unselected workspace', async () => {
  const result = await runFixture({}, { gate: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.events.filter((event) => event.kind === 'test').map((event) => event.project).sort(), ['alpha', 'beta']);
  assert.equal(new Set(result.events.filter((event) => event.kind === 'global').map((event) => event.pid)).size, 1);
});

test('native worker environment is restored before adjuncts and after success, startup and teardown failures', async () => {
  for (const failure of [{}, { FAIL_PROJECT: 'alpha' }, { FAIL_CONFIG: '1' }, { FAIL_CLOSE: 'alpha' }]) {
    const result = await runFixture({ VITEST_MAX_FORKS: '13', VITEST_MIN_FORKS: '1', VITEST_MAX_THREADS: undefined, VITEST_MIN_THREADS: undefined, ...failure }, { gate: true, observeEnv: true });
    if (Object.keys(failure).length === 0) assert.equal(result.code, 0, result.output);
    else assert.notEqual(result.code, 0, result.output);
    const environment = result.events.find((event) => event.kind === 'environment');
    assert.ok(environment, result.output);
    assert.deepEqual(environment.after, environment.before);
    for (const hook of result.events.filter((event) => event.kind === 'checks')) {
      assert.deepEqual(hook.poolEnv, environment.before, 'adjuncts must retain the caller environment');
    }
    if ('FAIL_CLOSE' in failure) assert.ok(result.events.some((event) => event.kind === 'close'));
  }
});

test('runs every workspace-derived plugin typecheck invocation', async () => {
  const executed: string[] = [];

  const invocations = await runPluginWorkspaceTests({
    scriptName: 'typecheck',
    discoverReport: async () => ({
      packages: [
        {
          packageName: '@happier-dev/plugins-alpha',
          workspaceDirectory: 'packages/plugins/alpha',
        },
      ],
      issues: [],
    }),
    runInvocation: async (invocation) => {
      executed.push(invocation.packageName);
    },
  });

  assert.deepEqual(executed, ['@happier-dev/plugins-alpha']);
  assert.deepEqual(invocations.map((invocation) => invocation.args), [
    ['--filter', '@happier-dev/plugins-alpha', '--silent', 'run', 'typecheck'],
  ]);
});

test('does not silently skip an empty or invalid plugin workspace selection', async () => {
  let invoked = false;

  await assert.rejects(
    runPluginWorkspaceTests({
      discoverReport: async () => ({
        packages: [],
        issues: ['No plugin workspace packages were found from root workspace metadata.'],
      }),
      runInvocation: async () => {
        invoked = true;
      },
    }),
    /No plugin workspace packages were found from root workspace metadata/,
  );

  assert.equal(invoked, false);
});

test('attempts every derived workspace before reporting failed package tests', async () => {
  const executed: string[] = [];

  await assert.rejects(
    runPluginWorkspaceTests({
      scriptName: 'typecheck',
      discoverReport: async () => ({
        packages: [
          {
            packageName: '@happier-dev/plugins-alpha',
            workspaceDirectory: 'packages/plugins/alpha',
          },
          {
            packageName: '@happier-dev/plugins-beta',
            workspaceDirectory: 'packages/plugins/beta',
          },
        ],
        issues: [],
      }),
      runInvocation: async (invocation) => {
        executed.push(invocation.packageName);
        if (invocation.packageName === '@happier-dev/plugins-alpha') {
          throw new Error('alpha failed');
        }
      },
    }),
    /@happier-dev\/plugins-alpha: alpha failed/,
  );

  assert.deepEqual(executed, [
    '@happier-dev/plugins-alpha',
    '@happier-dev/plugins-beta',
  ]);
});

test('runs independent plugin workspaces with bounded concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];

  const run = runPluginWorkspaceTests({
    scriptName: 'typecheck',
    maxConcurrent: 2,
    discoverReport: async () => ({
      packages: ['alpha', 'beta', 'gamma'].map((id) => ({
        packageName: `@happier-dev/plugins-${id}`,
        workspaceDirectory: `packages/plugins/${id}`,
      })),
      issues: [],
    }),
    runInvocation: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });

  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(releases.length, 2);
  releases.shift()?.();
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await run;

  assert.equal(maxActive, 2);
});
