import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../testkit/core/spawn_test_process.mjs';
import { writeBackendProfileArtifacts } from './backend-capture.mjs';
import { runPerformanceCli } from './perf.mjs';
import { runQaBrowserWorker } from '../utils/dev_targets/qa_browser.mjs';

// Real Node children are the OS/inspector boundary; Stack ownership, CDP,
// perf_hooks, profile reduction and the observer's control protocol stay real.
async function fixture(t) {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-backend-' });
  const root = temp.path('agent-qa-perf');
  await mkdir(root + '/logs', { recursive: true });
  await mkdir(root + '/cli/logs', { recursive: true });
  await writeFile(root + '/logs/server.log', '');
  const processes = [], inspectorStarts = new Map();
  t.after(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'close')));
  });
  const spawnOwned = async role => {
    const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', `
      import inspector from 'node:inspector';
      process.on('message', () => process.send({ inspectorClosed: inspector.url() === undefined,
        monitors: Object.keys(globalThis).filter(key => key.startsWith('__HAPPIER_PERF_BACKEND_')).length }));
      setInterval(() => { const end = performance.now() + 2; while (performance.now() < end) {} }, 20);
      process.send('ready');
    `], { env: { ...process.env, HAPPIER_STACK_STACK: 'agent-qa-perf', HAPPIER_STACK_ENV_FILE: root + '/env', HAPPIER_STACK_PROCESS_KIND: role },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', chunk => { if (chunk.toString().includes('Debugger listening on')) inspectorStarts.set(child.pid, (inspectorStarts.get(child.pid) ?? 0) + 1); });
    processes.push(child);
    await once(child, 'message');
    return child;
  };
  const server = await spawnOwned('server'), daemon = await spawnOwned('daemon');
  await writeFile(root + `/cli/logs/2026-10-22-pid-${daemon.pid}-daemon.log`, '');
  const state = { sourceUi: 'export', processes: { serverPid: server.pid, daemonPid: daemon.pid }, sourceRuntimeIdentities: {
    server: { selected: 'server-fixture', loaded: 'server-fixture' }, daemon: { selected: 'daemon-fixture', loaded: 'daemon-fixture' },
  } };
  const saveState = () => writeFile(root + '/stack.runtime.json', JSON.stringify(state));
  await saveState();
  const inspect = async child => { const result = once(child, 'message'); child.send('inspect'); return (await result)[0]; };
  const spawnNonNode = async () => {
    const child = spawnTestProcess('sleep', ['60'], { env: { ...process.env, HAPPIER_STACK_STACK: 'agent-qa-perf',
      HAPPIER_STACK_ENV_FILE: root + '/env', HAPPIER_STACK_PROCESS_KIND: 'server' }, stdio: 'ignore' });
    processes.push(child); await once(child, 'spawn'); return child;
  };
  const startObserver = async () => {
    const worker = spawnTestProcess(process.execPath, [new URL('./host-snapshot.mjs', import.meta.url).pathname,
      JSON.stringify({ observe: true, stack: 'agent-qa-perf', stackBaseDir: root })], { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.push(worker);
    let stderr = ''; worker.stderr.on('data', b => { stderr += b; });
    const records = [], lines = createInterface({ input: worker.stdout });
    let ready, nextId = 0, terminal;
    const pending = new Map(), logs = [];
    const readiness = new Promise(resolve => { ready = resolve; });
    lines.on('line', line => {
      const at = line.indexOf('='); if (at < 0) return;
      const event = line.slice(0, at), value = JSON.parse(line.slice(at + 1));
      records.push({ event, value });
      if (event === 'HAPPIER_PERF_OBSERVER_READY') ready(value);
      if (event === 'HAPPIER_PERF_OBSERVER_DONE') terminal = value;
      if (event === 'HAPPIER_PERF_LOG') logs.push(value);
      pending.get(value.id)?.(value); pending.delete(value.id);
    });
    const completed = once(worker, 'close');
    const initial = await Promise.race([readiness, completed.then(() => { throw Error('Observer failed before ready: ' + stderr); })]);
    const request = (op, extra = {}) => {
      const id = ++nextId;
      const response = new Promise(resolve => pending.set(id, resolve));
      worker.stdin.write(JSON.stringify({ op, id, ...extra }) + '\n');
      return Promise.race([response, completed.then(() => { throw Error('Observer ended before response: ' + stderr); })]);
    };
    let stopTask;
    // Only the OS/control transport is adapted for the fixture. The same real
    // source-side observer, runtime reader and capture implementation run below.
    return { records: logs, readiness: initial, events: records,
      sample: async () => (await request('sample')).snapshot,
      startBackendProfiles: roles => request('profiles.start', { roles }),
      finishBackendProfiles: async () => (await request('profiles.stop')).result,
      stop() { return stopTask ??= (async () => {
        worker.stdin.end(); const [code] = await completed;
        return { status: code === 0 && terminal && !terminal.failed ? 'CLOSED' : 'OBSERVER_FAILED', code, stderr, terminal };
      })(); },
    };
  };
  const observe = async ({ beforeStop, explicitFinish = false } = {}) => {
    const observer = await startObserver();
    const started = observer.startBackendProfiles(['server', 'daemon']);
    started.catch(() => {});
    // The existing sample command is a queue barrier even if profiles.start
    // were accidentally removed: final assertions fail instead of hanging.
    await observer.sample();
    await delay(80);
    await beforeStop?.();
    if (explicitFinish) {
      await observer.finishBackendProfiles();
    }
    const result = await observer.stop();
    return { ...result, records: observer.events,
      backendProfiles: observer.events.find(r => r.event === 'HAPPIER_PERF_PROFILE_RESULT')?.value.result ?? result.terminal?.backendProfiles };
  };
  return { root, state, server, daemon, saveState, inspect, observe, startObserver, spawnNonNode,
    inspectorStarts: child => inspectorStarts.get(child.pid) ?? 0 };
}

test('observer captures both owned backends through journey control and writes reduced artifacts once', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.observe({ explicitFinish: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.backendProfiles?.status, 'CAPTURED', JSON.stringify(Object.fromEntries(
    Object.entries(result.backendProfiles?.roles ?? {}).map(([role, value]) => [role, { status: value.status, error: value.error, cleanup: value.cleanup }]),
  )));
  assert.equal(result.terminal.backendProfiles, undefined, 'the terminal cleanup must not retransmit raw profiles');
  const metadata = await writeBackendProfileArtifacts(f.root, result.backendProfiles);
  for (const [role, child] of [['server', f.server], ['daemon', f.daemon]]) {
    const profile = result.backendProfiles.roles[role];
    assert.equal(profile.pid, child.pid);
    assert.ok(profile.profile.samples.length > 0);
    assert.ok(profile.cpu.sampledMs > 0);
    assert.ok(profile.metrics.cpu.user + profile.metrics.cpu.system > 0);
    assert.ok(profile.metrics.endMs >= profile.metrics.startMs);
    assert.ok(profile.metrics.delay.count > 0);
    assert.equal(profile.cleanup.inspectorReleased, true);
    const savedProfile = JSON.parse(await readFile(f.root + '/' + metadata.roles[role].artifacts.profile, 'utf8'));
    const savedSummary = JSON.parse(await readFile(f.root + '/' + metadata.roles[role].artifacts.cpu, 'utf8'));
    assert.equal(savedProfile.samples.length, profile.profile.samples.length);
    assert.equal(savedSummary.sampledMs, profile.cpu.sampledMs);
    assert.equal(metadata.roles[role].profile, undefined, 'journey metadata references the profile artifact instead of duplicating it');
    assert.deepEqual(await f.inspect(child), { inspectorClosed: true, monitors: 0 });
  }
});

test('control EOF cleans pinned captures even when changed runtime identity makes evidence incomplete', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.observe({ beforeStop: async () => {
    f.state.sourceRuntimeIdentities.server.loaded = 'replacement'; await f.saveState();
  } });
  assert.equal(result.terminal?.backendProfiles?.status, 'INCOMPLETE');
  assert.equal(result.terminal.backendProfiles.roles.server.status, 'FAILED');
  for (const child of [f.server, f.daemon]) assert.deepEqual(await f.inspect(child), { inspectorClosed: true, monitors: 0 });
});

test('occupied inspector is refused without signalling or closing either foreign listener or backend', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const foreign = createServer(socket => socket.end());
  await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(9229, '127.0.0.1', resolve); });
  t.after(() => foreign.listening ? new Promise(resolve => foreign.close(resolve)) : undefined);
  const result = await f.observe();
  assert.equal(result.terminal?.backendProfiles?.status, 'INCOMPLETE');
  assert.equal(foreign.listening, true);
  for (const child of [f.server, f.daemon]) assert.deepEqual(await f.inspect(child), { inspectorClosed: true, monitors: 0 });
  const lateRelease = await f.observe({ beforeStop: () => new Promise(resolve => foreign.close(resolve)) });
  assert.equal(lateRelease.backendProfiles.status, 'INCOMPLETE');
  for (const child of [f.server, f.daemon]) {
    assert.deepEqual(await f.inspect(child), { inspectorClosed: true, monitors: 0 });
    assert.equal(f.inspectorStarts(child), 0, 'cleanup must not attach a capture that never began, even if the foreign port becomes free');
  }
});

test('a runtime PID without the exact stack binding is refused and prior owned capture is retired', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  f.state.processes.daemonPid = process.pid; await f.saveState();
  const result = await f.observe();
  assert.equal(result.terminal?.backendProfiles?.status, 'INCOMPLETE');
  assert.equal(result.terminal.backendProfiles.roles.daemon.status, 'FAILED');
  for (const child of [f.server, f.daemon]) assert.deepEqual(await f.inspect(child), { inspectorClosed: true, monitors: 0 });
});

test('a stack-owned non-Node executable is refused before SIGUSR1 can terminate it', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), child = await f.spawnNonNode();
  f.state.processes.serverPid = child.pid; await f.saveState();
  const result = await f.observe();
  assert.equal(result.backendProfiles.status, 'INCOMPLETE');
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null, 'ownership alone must not authorize a Node-specific signal');
});

test('the journey entrypoint bundles real backend and browser evidence together and retires both', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const http = createHttpServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<div data-testid="session-list-view-options-trigger">Shell</div><script>
      globalThis.__HAPPIER_SYNC_PERFORMANCE__ = { isEnabled: () => globalThis.__HAPPIER_PERF_CAPTURE_MODE__ === 'counts',
        reset() {}, markScenario() {}, flush() { return { events: [] }; } };
    </script>`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const input = new PassThrough(), signalSource = new EventEmitter();
  let acceptReady;
  const ready = new Promise(resolve => { acceptReady = resolve; });
  const worker = runQaBrowserWorker({ sessionName: `backprof-bundle-${process.pid}`, input, writeReady: acceptReady }, { signalSource });
  let browser, context;
  t.after(async () => {
    try { await context?.close(); await browser?.close(); }
    finally { input.write('close\n'); try { await worker; } finally { input.destroy(); } }
  });
  const endpoint = await Promise.race([ready, worker.then(() => { throw Error('Fixture browser closed before readiness'); })]);
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const { chromium } = createRequire(`${repo}/packages/tests/package.json`)('@playwright/test');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`, { timeout: 0 });
  context = await browser.newContext();
  const page = await context.newPage();
  const url = `http://127.0.0.1:${http.address().port}`;
  await page.goto(url);
  const discovery = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
  const pageId = discovery.find(target => target.url === page.url()).id;
  const previousExitCode = process.exitCode;
  try {
    await runPerformanceCli(['journey', 'backend-fixture', '--session=BACKPROF-fixture', '--cache=warm', '--ui-mode=export',
      '--capture-mode=timing', '--backend-profile=server,daemon', `--cdp=http://127.0.0.1:${endpoint.port}`,
      `--page-id=${pageId}`, `--url=${url}`, '--home-selector=[data-testid="session-list-view-options-trigger"]', `--out=${f.root}/journey`], {
      definition: { id: 'backend-fixture', intent: 'Real browser and backend bundle contract', steps: [{ op: 'idle', ms: 100 }] },
      startHostObserver: f.startObserver,
    });
  } finally { process.exitCode = previousExitCode; }
  const read = async name => JSON.parse(await readFile(`${f.root}/journey/${name}`, 'utf8'));
  const bundle = await read('bundle.json');
  assert.notEqual(bundle.status, 'FAILED', JSON.stringify(await read('failure.json').catch(() => bundle)));
  assert.equal(bundle.backendProfiles.status, 'CAPTURED');
  assert.deepEqual(bundle.backendProfileRoles, ['server', 'daemon']);
  assert.ok((await read('cpu.cpuprofile')).samples.length > 0, 'browser profile stays beside backend artifacts');
  assert.equal((await read('backend-profiles.json')).roles.server.identity, 'server-fixture');
  assert.equal((await read('cleanup.json')).status, 'CLEANED');
  assert.equal((await read('host-observer.json')).status, 'CLOSED');
  for (const role of ['server', 'daemon']) {
    assert.ok((await read(`${role}.cpuprofile`)).samples.length > 0);
    assert.deepEqual(await f.inspect(f[role]), { inspectorClosed: true, monitors: 0 });
  }
});
