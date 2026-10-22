import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { isLogRecordStart, parseLogRecords } from './analysis.mjs';
import { isPidOwnedByStack } from '../utils/proc/ownership.mjs';
import { startBackendCapture } from './backend-capture.mjs';
import { readPerfStackRuntime } from './stack-runtime.mjs';

async function projectLines(lines, { path, startMs, endMs = Infinity, onRecord }) {
  let date = basename(path).match(/^(\d{4}-\d\d-\d\d)/)?.[1] ?? new Date(startMs).toISOString().slice(0, 10);
  let previousClock = '', block = '';
  const flush = () => {
    for (const record of parseLogRecords(block, { date, timezoneOffsetMinutes: new Date().getTimezoneOffset() })) {
      if (record.atMs >= startMs && record.atMs <= endMs) onRecord({ ...record, file: path,
        role: basename(path).endsWith('-daemon.log') ? 'daemon' : 'server' });
    }
    block = '';
  };
  for await (const line of lines) {
    if (isLogRecordStart(line)) {
      flush();
      const clock = line.match(/^\[(\d\d:\d\d:\d\d)/)?.[1];
      if (clock) {
        if (previousClock && clock < previousClock) date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        previousClock = clock;
      }
    }
    block += `${line}\n`;
  }
  flush();
}

export function processSnapshot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const fields = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pcpu=,rss=,time='], { encoding: 'utf8' }).trim().split(/\s+/);
    const clock = fields[3].split(/[:-]/).map(Number);
    let cpuSeconds = clock.pop() + clock.pop() * 60;
    if (clock.length) cpuSeconds += clock.pop() * 3600;
    if (clock.length) cpuSeconds += clock.pop() * 86400;
    return { pid, lifetimeCpuPercent: Number(fields[1]), rssBytes: Number(fields[2]) * 1024, cpuSeconds };
  } catch { return null; }
}

export async function snapshotHost({ stackBaseDir, stack, startMs, endMs }) {
  const root = resolve(stackBaseDir);
  const state = readPerfStackRuntime({ stackBaseDir, stack });
  const sampledAtMs = Date.now();
  const serverPid = state?.processes?.serverPid, daemonPid = state?.processes?.daemonPid;
  const ownedProcess = async pid => Number.isSafeInteger(pid) && await isPidOwnedByStack(pid, {
    stackName: stack, envPath: join(root, 'env'), cliHomeDir: join(root, 'cli'),
  }) ? processSnapshot(pid) : null;
  const server = await ownedProcess(serverPid), daemon = await ownedProcess(daemonPid);
  const files = [];
  for (const directory of [join(root, 'logs'), join(root, 'cli', 'logs')]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!/^(?:server\.log(?:\.\d+)?|.*-daemon\.log)$/.test(name)) continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.mtimeMs >= startMs) files.push(path);
    }
  }
  const records = [];
  if (endMs) for (const path of files) {
    // Stream lines and retain only diagnostics; raw request/SQL/auth bodies
    // never leave this process or get copied to an evidence directory.
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    await projectLines(lines, { path, startMs, endMs, onRecord: record => records.push(record) });
  }
  return { atMs: sampledAtMs, host: os.hostname(), platform: process.platform, arch: process.arch,
    cpus: os.cpus().length, load: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    identity: { mode: state?.runtimeMode, sourceUi: state?.sourceUi, uiDir: state?.sourceUiLaunch?.uiDir,
      roles: Object.fromEntries(['server', 'daemon'].map(role => [role, { selected: state?.sourceRuntimeIdentities?.[role]?.selected, loaded: state?.sourceRuntimeIdentities?.[role]?.loaded }])), startedAt: state?.startedAt },
    server, daemon,
    logs: { files, records } };
}

// Keep the existing projection at the source while debug logs rotate. Raw log
// lines never traverse SSH. The canonical executor's control-stdin/lifeline owns
// this observer; it is not a stack service or a new lifecycle authority.
async function observeHost(options) {
  if (process.platform === 'win32') throw new Error('Perf log observation requires the configured POSIX QA host');
  const initial = await snapshotHost({ ...options, startMs: Date.now() });
  const root = resolve(options.stackBaseDir);
  const daemonDirectory = join(root, 'cli/logs');
  const daemonName = existsSync(daemonDirectory) ? readdirSync(daemonDirectory).find(name => name.endsWith(`-pid-${initial.daemon?.pid}-daemon.log`)) : undefined;
  const daemonFile = daemonName ? join(daemonDirectory, daemonName) : undefined;
  const files = [join(root, 'logs/server.log'), ...(daemonFile ? [daemonFile] : [])];
  const emit = (name, value) => process.stdout.write(`HAPPIER_PERF_${name}=${JSON.stringify(value)}\n`);
  const tails = [], readers = [], exits = [];
  let closing = false, failed = false, backendCapture, backendProfiles, profilesReturned = false;
  const lifetime = new AbortController();
  const finishProfiles = async () => {
    if (backendCapture) backendProfiles = await backendCapture.finish();
    return backendProfiles;
  };
  for (const path of files) {
    const tail = spawn('tail', ['-n', '+1', '-F', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    tails.push(tail);
    exits.push(new Promise(resolveExit => {
      tail.once('error', () => { failed = true; emit('OBSERVER_ERROR', { phase: 'tail.spawn', role: path === files[0] ? 'server' : 'daemon' }); resolveExit({ pid: tail.pid ?? null, status: 'spawn-failed' }); });
      tail.once('close', (code, signal) => {
        if (!closing) { failed = true; emit('OBSERVER_ERROR', { phase: 'tail.closed', code, signal }); }
        resolveExit({ pid: tail.pid, code, signal });
      });
    }));
    readers.push(projectLines(createInterface({ input: tail.stdout, crlfDelay: Infinity }), {
      path, startMs: initial.atMs,
      onRecord: record => {
        if (['web-latency', 'daemon-control', 'external-action-stage'].includes(record.module)) emit('LOG', record);
      },
    }));
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.once('close', () => lifetime.abort());
  const stop = () => { closing = true; lifetime.abort(); for (const tail of tails) tail.kill('SIGTERM'); input.close(); process.stdin.pause(); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  emit('OBSERVER_READY', { initial, files, pid: process.pid, tailPids: tails.map(tail => tail.pid), daemonFileAvailable: Boolean(daemonFile) });
  try {
    for await (const line of input) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.op === 'stop') break;
      if (message.op === 'sample') emit('SAMPLE', { id: message.id, snapshot: await snapshotHost({ ...options, startMs: Date.now() }) });
      if (message.op === 'profiles.start') {
        if (backendCapture) throw new Error('Backend profiles already started');
        backendCapture = await startBackendCapture({ ...options, roles: message.roles, signal: lifetime.signal,
          expected: Object.fromEntries(['server', 'daemon'].map(role => [role, { pid: initial[role]?.pid, loaded: initial.identity.roles[role]?.loaded }])) });
        emit('PROFILE_STARTED', { id: message.id, status: backendCapture.status });
      }
      if (message.op === 'profiles.stop') {
        emit('PROFILE_RESULT', { id: message.id, result: await finishProfiles() });
        profilesReturned = true;
      }
    }
  } finally {
    stop(); await Promise.all(readers);
    await finishProfiles();
    emit('OBSERVER_DONE', { failed, tails: await Promise.all(exits), atMs: Date.now(),
      backendProfiles: profilesReturned ? undefined : backendProfiles,
      backendProfileCleanup: backendProfiles ? Object.fromEntries(Object.entries(backendProfiles.roles).map(([role, value]) => [role, { status: value.status, cleanup: value.cleanup }])) : undefined });
    for (const signal of signals) process.off(signal, stop);
  }
}

export async function startHostObserver() {
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const { resolveRemoteStackStatePaths } = await import('../utils/dev_targets/remote_commands.mjs');
  const { runDevTargetCommand } = await import('../utils/dev_targets/executor.mjs');
  const { spawnProc } = await import('../utils/proc/proc.mjs');
  const { config, path: configPath } = await loadDevTargetsConfig({ stackName: 'agent-qa-perf' });
  const targetName = config.runtimePlacement.server.target;
  if (!targetName || targetName !== config.runtimePlacement.daemon.target) throw new Error('Perf observer requires the configured colocated server/daemon');
  const target = config.targets.find(candidate => candidate.name === targetName);
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa-perf', runtimeMode: 'controlled' });
  const signalBus = new EventEmitter(), pending = new Map(), records = [];
  let worker, readiness, terminal, nextId = 0, stopTask, executionEnded = false;
  let acceptReady, rejectReady;
  const ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const fail = () => {
    const error = new Error('Host observer source/control unavailable; raw diagnostics suppressed');
    rejectReady(error);
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  };
  const completion = runDevTargetCommand({ target, stackBaseDir: dirname(configPath),
    commandArgs: ['node', 'apps/stack/scripts/perf/host-snapshot.mjs', JSON.stringify({ observe: true, stack: 'agent-qa-perf', stackBaseDir: paths.stackBaseDir })],
    controlStdin: true, silent: true, workspacePreparation: 'skip', dependencyAdmission: 'skip', provenance: 'skip',
    onLine: ({ stream, line }) => {
      if (stream !== 'stdout' || !line.startsWith('HAPPIER_PERF_')) return;
      const index = line.indexOf('=');
      let value; try { value = JSON.parse(line.slice(index + 1)); } catch { fail(); return; }
      if (line.startsWith('HAPPIER_PERF_LOG=')) records.push(value);
      else if (line.startsWith('HAPPIER_PERF_OBSERVER_READY=')) { readiness = value; acceptReady(value); }
      else if (line.startsWith('HAPPIER_PERF_SAMPLE=')) {
        value.snapshot.target = targetName;
        pending.get(value.id)?.accept(value.snapshot); pending.delete(value.id);
      } else if (line.startsWith('HAPPIER_PERF_OBSERVER_DONE=')) terminal = value;
      else if (line.startsWith('HAPPIER_PERF_PROFILE_STARTED=')) {
        pending.get(value.id)?.accept(value); pending.delete(value.id);
      } else if (line.startsWith('HAPPIER_PERF_PROFILE_RESULT=')) {
        pending.get(value.id)?.accept(value.result); pending.delete(value.id);
      }
      else if (line.startsWith('HAPPIER_PERF_OBSERVER_ERROR=')) fail();
    },
  }, { signalSource: signalBus,
    spawnProcess: ({ label, command, args, env, onLine, silent }) => {
      worker = spawnProc(label, command, args, env, { onLine, silent, persistOutput: false, stdio: ['pipe', 'pipe', 'pipe'] });
      worker.stdin.on('error', () => { fail(); signalBus.emit('SIGINT'); });
      return worker;
    },
  }).then(result => { executionEnded = true; if (!readiness || pending.size) fail(); return result; }, error => { executionEnded = true; fail(); throw error; });
  // Failure is observed by ready/sample/stop, never an unhandled background rejection.
  completion.catch(() => {});
  try { await ready; }
  catch (error) { signalBus.emit('SIGINT'); await completion.catch(() => {}); throw error; }
  return { records, readiness,
    sample() {
      if (executionEnded) return Promise.reject(new Error('Host observer ended before sample'));
      const id = ++nextId;
      const result = new Promise((accept, reject) => pending.set(id, { accept, reject }));
      worker.stdin.write(JSON.stringify({ op: 'sample', id }) + '\n');
      return result;
    },
    startBackendProfiles(roles) {
      if (executionEnded) return Promise.reject(new Error('Host observer ended before profiling'));
      const id = ++nextId;
      const result = new Promise((accept, reject) => pending.set(id, { accept, reject }));
      worker.stdin.write(JSON.stringify({ op: 'profiles.start', id, roles }) + '\n');
      return result;
    },
    finishBackendProfiles() {
      if (executionEnded) return Promise.reject(new Error('Host observer ended before profile finalization'));
      const id = ++nextId;
      const result = new Promise((accept, reject) => pending.set(id, { accept, reject }));
      worker.stdin.write(JSON.stringify({ op: 'profiles.stop', id }) + '\n');
      return result;
    },
    stop() {
      return stopTask ??= (async () => {
        if (!executionEnded) worker.stdin.write('{"op":"stop"}\n');
        const result = await completion.catch(() => ({ code: 1 }));
        return { status: result.code === 0 && terminal && !terminal.failed ? 'CLOSED' : 'OBSERVER_FAILED', readiness, terminal: terminal ?? null };
      })();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const options = JSON.parse(process.argv[2]);
    if (options.observe) await observeHost(options);
    else console.log(`HAPPIER_PERF_HOST=${JSON.stringify(await snapshotHost(options))}`);
  } catch { console.error('Host snapshot failed; raw diagnostics suppressed'); process.exitCode = 1; }
}
