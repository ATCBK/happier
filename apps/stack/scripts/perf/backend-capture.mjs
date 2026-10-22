import { randomUUID } from 'node:crypto';
import { readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { isPidOwnedByStack } from '../utils/proc/ownership.mjs';
import { runCapture } from '../utils/proc/proc.mjs';
import { isTcpPortListening, listListenPidsWithStatus } from '../utils/net/ports.mjs';
import { createCdpConnection } from '../../../ui/scripts/perf/agentBrowserUiPerfAudit.mjs';
import { safeUrl, summarizeProfile } from './analysis.mjs';
import { readPerfStackRuntime } from './stack-runtime.mjs';

const endpoint = 'http://127.0.0.1:9229';

export async function writeBackendProfileArtifacts(output, result) {
  if (!result) return undefined;
  const roles = {};
  const writeJson = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  for (const role of ['server', 'daemon']) {
    const value = result.roles[role]; if (!value) continue;
    const { profile, cpu, ...metadata } = value;
    const artifacts = {};
    if (profile) { artifacts.profile = `${role}.cpuprofile`; await writeJson(artifacts.profile, profile); }
    if (cpu) { artifacts.cpu = `${role}-cpu-summary.json`; await writeJson(artifacts.cpu, cpu); }
    artifacts.runtime = `${role}-runtime.json`;
    await writeJson(artifacts.runtime, metadata);
    roles[role] = { ...metadata, ...(cpu ? { cpu: { sampledMs: cpu.sampledMs, wallMs: cpu.wallMs } } : {}), artifacts };
  }
  const metadata = { ...result, roles };
  await writeJson('backend-profiles.json', metadata);
  return metadata;
}

export function parseBackendProfileRoles(value) {
  if (value === undefined) return [];
  const roles = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(roles) || !roles.length || roles.some(role => !['server', 'daemon'].includes(role))
    || new Set(roles).size !== roles.length) throw new Error('Backend profiles require server, daemon, or server,daemon');
  return roles;
}

// Executed in the target process via a short-lived, PID-verified CDP connection.
// A process-local Session keeps profiling when the TCP inspector is released,
// so both colocated roles can record concurrently without moving debug ports.
async function beginInProcess(key) {
  const p = process.getBuiltinModule('node:perf_hooks');
  const session = new (process.getBuiltinModule('node:inspector').Session)();
  const h = p.monitorEventLoopDelay({ resolution: 20 });
  const post = method => new Promise((accept, reject) => session.post(method, (error, result) => error ? reject(error) : accept(result)));
  if (Object.keys(globalThis).some(name => name.startsWith('__HAPPIER_PERF_BACKEND_'))) throw new Error('Backend capture already active');
  const state = { p, session, h, post, startMs: Date.now(), cpu: process.cpuUsage(), elu: p.performance.eventLoopUtilization() };
  globalThis[key] = state;
  try {
    session.connect(); h.enable();
    await post('Profiler.enable'); await post('Profiler.start');
    return { startMs: state.startMs, pid: process.pid, node: process.version };
  } catch (error) {
    h.disable(); session.disconnect(); delete globalThis[key]; throw error;
  }
}

async function finishInProcess(key) {
  const state = globalThis[key];
  if (!state) throw new Error('Backend capture state unavailable');
  try {
    const { profile } = await state.post('Profiler.stop');
    state.h.disable();
    const measured = state.h.count > 0;
    return { profile, metrics: { startMs: state.startMs, endMs: Date.now(), cpu: process.cpuUsage(state.cpu),
      elu: state.p.performance.eventLoopUtilization(state.elu), memory: process.memoryUsage(),
      delay: { resolutionMs: 20, count: state.h.count, minMs: measured ? state.h.min / 1e6 : null,
        maxMs: measured ? state.h.max / 1e6 : null, meanMs: measured ? state.h.mean / 1e6 : null,
        p50Ms: measured ? state.h.percentile(50) / 1e6 : null,
        p95Ms: measured ? state.h.percentile(95) / 1e6 : null, p99Ms: measured ? state.h.percentile(99) / 1e6 : null } } };
  } finally {
    state.h.disable(); state.session.disconnect(); delete globalThis[key];
  }
}

export async function startBackendCapture(options) {
  if (process.platform === 'win32') throw new Error('Backend SIGUSR1 profiling requires the configured POSIX Node QA host');
  const roles = parseBackendProfileRoles(options.roles);
  const initial = readPerfStackRuntime(options);
  const captures = [], failures = {};
  const ownership = { stackName: options.stack, envPath: join(options.stackBaseDir, 'env'), cliHomeDir: join(options.stackBaseDir, 'cli') };
  const assertProcess = async target => {
    if (!target.fingerprint || readProcessInstanceFingerprintSync(target.pid) !== target.fingerprint
      || !await isPidOwnedByStack(target.pid, ownership)) throw new Error('Backend process ownership changed');
  };
  const assertRuntime = target => {
    const state = readPerfStackRuntime(options), identity = state?.sourceRuntimeIdentities?.[target.role];
    if (state?.processes?.[target.role + 'Pid'] !== target.pid || identity?.selected !== target.identity || identity?.loaded !== target.identity) {
      throw new Error('Backend loaded runtime changed');
    }
  };
  const assertNode = async target => {
    // SIGUSR1 is fatal to ordinary executables. Stack ownership alone does not
    // prove a recorded PID runs the Node source-runtime supported here.
    const executable = process.platform === 'linux' ? await readlink(`/proc/${target.pid}/exe`)
      : (await runCapture('ps', ['-p', String(target.pid), '-o', 'comm='])).trim();
    if (!['node', 'nodejs'].includes(basename(executable))) throw new Error('Backend profiling requires a Node executable');
  };
  const evaluate = async (cdp, expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Backend inspector evaluation failed');
    return result.result.value;
  };
  async function inspect(target, expression, signal, starting = false) {
    await assertProcess(target);
    signal?.throwIfAborted();
    if (await isTcpPortListening(9229)) throw new Error('Backend inspector port is occupied');
    // Recheck immediately before the only signal; never substitute another PID.
    await assertNode(target);
    await assertProcess(target);
    process.kill(target.pid, 'SIGUSR1');
    let cdp, verified = false;
    try {
      let url;
      while (!url) {
        await assertProcess(target);
        try {
          const response = await fetch(endpoint + '/json/list');
          if (response.ok) url = (await response.json())[0]?.webSocketDebuggerUrl;
        } catch { /* The exact process may still be opening its inspector. */ }
        if (!url) await delay(100);
      }
      const address = new URL(url);
      if (address.hostname !== '127.0.0.1' || address.port !== '9229') throw new Error('Backend inspector is not the expected loopback endpoint');
      cdp = await createCdpConnection(url);
      if (await evaluate(cdp, 'process.pid') !== target.pid) throw new Error('Backend inspector PID mismatch');
      await assertProcess(target); verified = true;
      // Once signalled, finish acquiring/retiring our inspector even if the
      // journey was cancelled during setup. Never leave a newly opened port.
      signal?.throwIfAborted();
      if (starting) target.captureMayExist = true;
      return await evaluate(cdp, expression);
    } finally {
      // Close only a connection whose process identity we actually verified.
      if (verified) await evaluate(cdp, 'setImmediate(()=>process.getBuiltinModule("node:inspector").close());true').catch(() => {});
      cdp?.close();
      if (verified) {
        while (true) {
          const listener = await listListenPidsWithStatus(9229, { candidatePids: [target.pid] });
          if (listener.status !== 'ok') throw new Error('Backend inspector release could not be verified');
          if (!listener.pids.includes(target.pid)) break;
          await delay(10);
        }
      }
    }
  }
  for (const role of roles) {
    const pid = initial?.processes?.[role + 'Pid'], identity = initial?.sourceRuntimeIdentities?.[role];
    const target = { role, pid, identity: identity?.loaded, fingerprint: Number.isSafeInteger(pid) ? readProcessInstanceFingerprintSync(pid) : null,
      key: '__HAPPIER_PERF_BACKEND_' + randomUUID().replaceAll('-', '') };
    try {
      if (!target.identity || identity.selected !== target.identity || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Backend loaded identity or PID unavailable');
      const expected = options.expected?.[role];
      if (expected && (expected.pid !== pid || expected.loaded !== target.identity)) throw new Error('Backend runtime differs from observed host');
      assertRuntime(target);
      // Retain the original cleanup target even if setup succeeds inside the
      // process but the final CDP response or listener observation fails.
      captures.push(target);
      target.begin = await inspect(target, '(' + beginInProcess.toString() + ')(' + JSON.stringify(target.key) + ')', options.signal, true);
    } catch (error) { target.setupError = error.message; failures[role] = { status: 'FAILED', error: error.message }; break; }
  }
  let finished;
  return { status: Object.keys(failures).length ? 'INCOMPLETE' : 'RECORDING',
    finish() {
      return finished ??= (async () => {
        const results = { ...failures };
        for (const target of captures) {
          if (!target.captureMayExist) continue;
          let runtimeError = target.setupError;
          try { assertRuntime(target); } catch (error) { runtimeError = error.message; }
          try {
            // Even after a runtime swap/abort, retire only the original owned
            // process incarnation. A successor never inherits its cleanup.
            const result = await inspect(target, '(' + finishInProcess.toString() + ')(' + JSON.stringify(target.key) + ')');
            try { assertRuntime(target); } catch (error) { runtimeError = error.message; }
            const profile = { ...result.profile, nodes: result.profile.nodes.map(node => ({ ...node, callFrame: { ...node.callFrame, url: safeUrl(node.callFrame.url) } })) };
            results[target.role] = { status: runtimeError ? 'FAILED' : 'CAPTURED', ...(runtimeError ? { error: runtimeError } : {}),
              pid: target.pid, identity: target.identity, processInstance: target.fingerprint, node: target.begin?.node,
              ...result, profile, cpu: summarizeProfile(profile), cleanup: { inspectorReleased: true, monitorRemoved: true, sessionDisconnected: true } };
          } catch (error) {
            results[target.role] = { status: 'FAILED', pid: target.pid, identity: target.identity, error: error.message,
              cleanup: { inspectorReleased: false, monitorRemoved: false, sessionDisconnected: false } };
          }
        }
        return { status: roles.every(role => results[role]?.status === 'CAPTURED') ? 'CAPTURED' : 'INCOMPLETE', roles: results,
          scope: 'Shared processes across all clients. CPU profiles sample the main isolate; process CPU includes native threads. Event-loop utilization is elapsed activity, not CPU. Backend windows bracket browser work and retain their own timestamps; profiling/attach overhead is included.' };
      })();
    },
  };
}
