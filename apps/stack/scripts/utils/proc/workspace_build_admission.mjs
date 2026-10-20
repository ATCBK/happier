import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { constants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { parseWorkspaceLockLeaseValue } from '../../../../../packages/cli-common/workspaceLockLease.mjs';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { callerHoldsDependencyConsumption, resolveDependencyInstallRoot, resolveDependencyRefreshLockPath, withDependencyConsumption } from './dependency_refresh.mjs';
import { JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE } from './jsonOwnerFileLock.mjs';
import { spawnForegroundCommand } from './proc.mjs';

const workerPath = fileURLToPath(import.meta.url);
const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The startup worker owns this policy for its entire finite construction,
 * including nested compiler leaves. Routing markers alone grant no exemption. */
export function isWorkspaceBuildStartup({ env = process.env, devStartup = false } = {}) {
  return devStartup || env.HAPPIER_WORKSPACE_BUILD_STARTUP === '1';
}

async function hasInheritedBuildCustody(env) {
  if (callerHoldsDependencyConsumption(env)) return true;
  const { callerHoldsWorkspaceBundleLock } = await import('../../../../../packages/cli-common/workspaceBundleLock.mjs');
  let leases;
  try { leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'); }
  catch { leases = []; }
  const values = [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    ...(Array.isArray(leases) ? leases : [])];
  return values.some(value => {
    const lease = parseWorkspaceLockLeaseValue(value);
    return lease !== null && callerHoldsWorkspaceBundleLock(lease.path, value);
  });
}

/** Finite build transport. The native owner decides capacity; this adapter
 * supplies only its existing canonical workspace leases and process boundary.
 */
export function resolveWorkspaceBuildAdmissionInvocation({ command, args = [], locks = [],
  repoDir = sourceRoot, launcherPath = resolve(repoDir, 'apps/stack/bin/hstack-exec'), env = process.env,
  admissionClass = 'package-dist', admissionRequired = true, dependencyInstallDir, devStartup = false }) {
  locks = workspaceBuildResources(locks, dependencyInstallDir, env);
  if (isWorkspaceBuildStartup({ env, devStartup })) {
    // Stack's own source construction is startup-critical, with private
    // outputs. Reuse protected local jobs placement and resource custody,
    // without joining validation's capacity queue.
    const workerArgs = [workerPath, '--dev-startup', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args];
    return process.platform === 'win32'
      ? { command: process.execPath, args: workerArgs }
      : { command: '/bin/sh', args: [launcherPath, '--local', '--', process.execPath, ...workerArgs] };
  }
  return process.platform === 'win32' || !admissionRequired
    ? { command: process.execPath, args: [workerPath, '--standalone', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args] }
    : { command: '/bin/sh', args: [launcherPath, '--heavyweight-admission', `--class=${admissionClass}`,
      `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
      `--workspace-locks=${JSON.stringify(locks)}`, '--', command, ...args] };
}

export async function runWorkspaceBuildAdmission({ command, args = [], locks = [], cwd = process.cwd(),
  repoDir = sourceRoot, launcherPath = resolve(repoDir, 'apps/stack/bin/hstack-exec'), env = process.env,
  signal, admissionClass = 'package-dist', admissionRequired = true, dependencyInstallDir, devStartup = false,
  stdio = 'inherit', onStdout, onStderr, captureStdout = true, captureStderr = true }) {
  const invocation = resolveWorkspaceBuildAdmissionInvocation({ command, args, locks, repoDir,
    launcherPath, env, admissionClass, admissionRequired, dependencyInstallDir, devStartup });
  if (isWorkspaceBuildStartup({ env, devStartup })) env = { ...env, HAPPIER_HSTACK_DISPATCH_CONTROL: '1' };
  return await new Promise(resolveResult => {
    const child = spawnForegroundCommand(invocation.command, invocation.args, {
      cwd, env, signal, stdio, ownedProcessGroup: true,
    });
    // Native admission settles interruption with a numeric shell status. Keep
    // the caller's actual signal distinct from an ordinary numeric child exit;
    // foreground custody still owns forwarding and waits for the tree to close.
    let callerSignal = null;
    const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(name =>
      [name, () => { callerSignal ??= name; }]));
    for (const [name, handler] of handlers) process.on(name, handler);
    let stdout = '', stderr = '', error;
    child.stdout?.on('data', value => { if (captureStdout) stdout += value; onStdout?.(value); });
    child.stderr?.on('data', value => { if (captureStderr) stderr += value; onStderr?.(value); });
    child.once('error', value => { error = value; });
    child.once('close', (status, terminalSignal) => {
      for (const [name, handler] of handlers) process.off(name, handler);
      resolveResult({ status: callerSignal ? null : status, signal: callerSignal ?? terminalSignal,
        ...(child.stdout ? { stdout } : {}), ...(child.stderr ? { stderr } : {}), ...(error ? { error } : {}) });
    });
  });
}

function workspaceBuildResources(locks, dependencyInstallDir, env) {
  if (!dependencyInstallDir) return locks;
  const installDir = resolveDependencyInstallRoot(dependencyInstallDir);
  return [{ kind: 'dependency', installDir, path: resolveDependencyRefreshLockPath(installDir, env) }, ...locks];
}

function parseLocks(raw) {
  const locks = JSON.parse(raw);
  if (!Array.isArray(locks)) throw new Error('Workspace admission requires a lock array');
  for (const lock of locks) {
    if (!lock || typeof lock.path !== 'string' || !lock.path.trim()
      || (lock.kind !== undefined && lock.kind !== 'workspace' && lock.kind !== 'dependency')
      || (lock.kind === 'dependency' && typeof lock.installDir !== 'string')) {
      throw new Error('Workspace admission requires canonical workspace lock paths');
    }
  }
  return locks;
}

function admissionChangeObservation(locks, env) {
  const root = env.HSTACK_ADMISSION_WAIT_ROOT;
  const waiter = env.HSTACK_ADMISSION_WAITER;
  const lockPaths = locks.flatMap(lock => [resolve(lock.path), `${resolve(lock.path)}.priority-claim`]);
  const dependencyWaiters = locks.filter(lock => lock.kind === 'dependency').map(lock => `${resolve(lock.path)}.waiters`);
  let resourcesRelevant = true;
  const observer = createFileChangeObserver([...new Set([
    ...(root ? [join(root, 'owners'), join(root, 'waiters')] : []), ...lockPaths.map(dirname), ...dependencyWaiters,
  ])], {
    // These parent directories also carry logs, queue-gate attempts and other
    // publishers. Only exclusion/admission changes justify reading all leases.
    isRelevant: (directory, filename) => filename == null
      || (root && directory === join(root, 'owners'))
      || (root && directory === join(root, 'waiters') && join(directory, String(filename)) !== waiter)
      || (resourcesRelevant && ((dependencyWaiters.includes(directory) && /^\d+\.json$/.test(String(filename)))
        || lockPaths.some(path => dirname(path) === directory && basename(path) === String(filename)))),
  });
  const raw = path => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const entries = directory => {
    try { return readdirSync(directory).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const readSnapshot = (includeResources = true) => JSON.stringify([
    root ? entries(join(root, 'owners')) : [],
    root ? entries(join(root, 'waiters')).filter(name => join(root, 'waiters', name) !== waiter)
      .map(name => [name, raw(join(root, 'waiters', name))]) : [],
    includeResources ? lockPaths.map(path => {
      const value = raw(path);
      try {
        const { updatedAtMs, ...identity } = JSON.parse(value);
        return identity;
      } catch { return value; }
    }) : [],
    includeResources ? dependencyWaiters.map(directory => entries(directory).filter(name => /^\d+\.json$/.test(name))
      .map(name => {
        const value = raw(join(directory, name));
        try { const { updatedAtMs, ...identity } = JSON.parse(value); return [name, identity]; }
        catch { return [name, value]; }
      })) : [],
  ]);
  return { observer, readSnapshot, readAdmissionSnapshot: () => readSnapshot(false),
    observeResources: value => { resourcesRelevant = value; } };
}

/** Non-Linux and in-process publishers use the same all-resource attempt as
 * native admission. Contention unwinds every new scope before observation;
 * errors from an entered publisher are terminal and never replayed.
 */
export async function withWorkspaceBuildResources({ locks = [], dependencyInstallDir, env = process.env, signal }, run) {
  locks = workspaceBuildResources(locks, dependencyInstallDir, env);
  const observation = admissionChangeObservation(locks, env);
  const inherited = await hasInheritedBuildCustody(env);
  let waited = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const snapshot = observation.observer.capture(observation.readSnapshot);
      let entered = false;
      try {
        return await withLocks(locks, env, signal, async acquiredEnv => {
          entered = true;
          return await run(acquiredEnv, { waited });
        });
      } catch (error) {
        if (entered || inherited || env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0'
          || process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0'
          || ![WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE].includes(error?.code)) throw error;
        if (!waited) console.error(error.message);
        waited = true;
      }
      await observation.observer.wait({ snapshot, readSnapshot: observation.readSnapshot,
        maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal });
    }
  } finally {
    observation.observer.close();
  }
}

async function withLocks(locks, env, signal, run, index = 0) {
  if (index === locks.length) return await run(env);
  const lock = locks[index];
  if (lock.kind === 'dependency') {
    if (resolve(lock.path) !== resolveDependencyRefreshLockPath(lock.installDir, env)) {
      throw new Error('Dependency admission requires its canonical installed-tree lock');
    }
    return await withDependencyConsumption({ installDir: lock.installDir, env, signal, wait: false }, env =>
      withLocks(locks, env, signal, run, index + 1));
  }
  return await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const leases = env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES
      ? JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES) : [];
    if (!Array.isArray(leases) || leases.some(value => typeof value !== 'string')) {
      throw new Error('Workspace admission requires an array of existing lock leases');
    }
    return await withLocks(locks, { ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([...new Set([...leases, heldLockValue])]),
    }, signal, run, index + 1);
  }, {
    lockPath: resolve(lock.path), env, signal, wait: false,
    ...(lock.timeoutMs !== undefined ? { timeoutMs: lock.timeoutMs === null ? Infinity : lock.timeoutMs } : {}),
    ...(lock.staleAfterMs !== undefined ? { staleAfterMs: lock.staleAfterMs === null ? Infinity : lock.staleAfterMs } : {}),
    ...(lock.pollIntervalMs !== undefined ? { pollIntervalMs: lock.pollIntervalMs } : {}),
    ...(lock.errorLabel !== undefined ? { errorLabel: lock.errorLabel } : {}),
  });
}

/** Private lease worker. Control uses inherited FDs, never payload stdio or a
 * durable state record. Closing custody aborts acquisition and releases scopes.
 */
export async function runWorkspaceBuildAdmissionWorker(argv) {
  if (argv.length === 1 && argv[0] === '--held-lock-probe') {
    try {
      process.exitCode = await hasInheritedBuildCustody(process.env) ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      // Exit 1 means an authenticated lease is absent. A probe failure must
      // remain distinct so the native owner cannot treat it as permission.
      process.exitCode = 2;
    }
    return;
  }
  const [mode, rawLocks, launcherPath, admissionClass, delimiter, command, ...args] = argv;
  // Already-parsed launchers still use --worker and --worker-try. Keep their
  // one-attempt transport while current launchers reuse event-wait custody.
  if (!['--worker', '--worker-try', '--worker-events', '--worker-events-inherited', '--worker-inherited', '--standalone', '--dev-startup'].includes(mode) || delimiter !== '--' || !command) {
    throw new Error('Invalid workspace admission worker invocation');
  }
  const locks = parseLocks(rawLocks);
  if (mode === '--dev-startup') process.env.HAPPIER_WORKSPACE_BUILD_STARTUP = '1';
  const inheritedBuildCustody = await hasInheritedBuildCustody(process.env);
  if (mode === '--standalone' && process.platform === 'linux') {
    const { requiresTypeScriptAdmission } = await import('../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
    if (requiresTypeScriptAdmission({ env: process.env, platform: process.platform })) {
      throw new Error('A workspace build requiring native admission cannot use standalone execution');
    }
  }
  const cancellation = new AbortController();
  let controls, controlInput;
  const interrupt = () => {
    cancellation.abort();
    controls?.close();
    controlInput?.destroy();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  // A native pipe uses event-loop custody, not a blocking filesystem read
  // which can strand the worker during cancellation or normal lock release.
  const standalone = mode === '--standalone' || mode === '--dev-startup';
  controlInput = !standalone ? new Socket({ fd: 4, readable: true, writable: false }) : null;
  controls = controlInput ? createInterface({ input: controlInput }) : null;
  const lines = controls?.[Symbol.asyncIterator]();
  controls?.once('close', interrupt);
  let result = { status: 0, signal: null };
  const eventMode = mode === '--worker-events' || mode === '--worker-events-inherited';
  const observation = eventMode ? admissionChangeObservation(locks, process.env) : null;
  let waitSnapshot;
  let waitReadSnapshot;
  let running = false;
  let reportedBusy = false;
  const acquire = standalone || mode === '--worker'
    ? run => withWorkspaceBuildResources({ locks, env: process.env, signal: cancellation.signal }, run)
    : run => withLocks(locks, process.env, cancellation.signal, run);
  try {
    do {
      let admissionSnapshot;
      let resourcesAcquired = false;
      if (eventMode) {
        observation.observeResources(true);
        waitReadSnapshot = observation.readSnapshot;
        waitSnapshot = observation.observer.capture(waitReadSnapshot);
        admissionSnapshot = observation.readAdmissionSnapshot();
      }
      try {
        await acquire(async env => {
          resourcesAcquired = true;
          if (!standalone) {
            writeSync(3, inheritedBuildCustody ? 'ready-inherited\n' : 'ready\n');
            const decision = await lines.next();
            if (decision.done || decision.value === 'release') return;
            if (decision.value !== 'run') throw new Error('Invalid workspace admission decision');
            running = true;
            const values = [];
            for (let index = 0; index < 3; index++) {
              const value = await lines.next();
              if (value.done) throw new Error('Workspace admission custody closed before payload');
              values.push(value.value);
            }
            [env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN, env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT,
              env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE] = values;
            // This decision is native-owned. The restriction grants no admission;
            // the nested native guard still authenticates the original token.
            env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED = '0';
          }
          delete env.HSTACK_ADMISSION_WAIT_ROOT;
          delete env.HSTACK_ADMISSION_WAITER;
          cancellation.signal.throwIfAborted();
          const invocation = standalone
            ? process.platform === 'win32'
              ? (await import('../process/resolveCommandInvocation.mjs')).resolveCommandInvocation({ command, args, env })
              : { command, args }
            : { command: '/bin/sh', args: [launcherPath, '--heavyweight-admission', `--class=${admissionClass}`,
              `--machine=${env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE || 'local'}`, '--', command, ...args] };
          result = await new Promise(resolveResult => {
            const child = spawn(invocation.command, invocation.args, { env, signal: cancellation.signal, stdio: 'inherit',
              ...(invocation.windowsVerbatimArguments !== undefined ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}) });
            let error;
            child.once('error', value => { error = value; });
            child.once('close', (status, terminalSignal) => resolveResult({ status, signal: terminalSignal, ...(error ? { error } : {}) }));
          });
        });
      } catch (error) {
        if (mode !== '--worker-events' || ![WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE].includes(error?.code)) throw error;
        // All scopes have unwound before native code marks this head busy.
        if (!reportedBusy) console.error(error.message);
        reportedBusy = true;
        writeSync(3, 'busy\n');
      }
      if (!eventMode || running) break;
      if (resourcesAcquired) {
        // Capacity/queue denial released otherwise available resources. Their
        // independent publishers cannot free capacity; watching their transient
        // leases makes queued workers repeatedly wake one another.
        observation.observeResources(false);
        waitReadSnapshot = observation.readAdmissionSnapshot;
        waitSnapshot = admissionSnapshot;
      }
      writeSync(3, 'released\n');
      const decision = await lines.next();
      if (decision.done) break;
      if (!decision.value.startsWith('wait ')) throw new Error('Invalid workspace admission wait');
      const maxWaitMs = Number(decision.value.slice(5));
      if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new Error('Invalid workspace admission catch-up');
      await observation.observer.wait({ snapshot: waitSnapshot, readSnapshot: waitReadSnapshot,
        maxWaitMs, signal: cancellation.signal });
      writeSync(3, 'changed\n');
      const retry = await lines.next();
      if (retry.done) break;
      if (retry.value !== 'try') throw new Error('Invalid workspace admission retry');
    } while (!cancellation.signal.aborted);
  } catch (error) {
    if (!cancellation.signal.aborted) {
      if ([WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE].includes(error?.code)) {
        if (mode === '--worker-try') {
          // withLocks has unwound every acquired scope before readiness is
          // reported. The native owner may now yield queue-head priority.
          console.error(error.message);
          writeSync(3, 'busy\n');
        } else {
          throw new Error('HSTACK_WORKSPACE_ADMISSION_ORDER: an admitted ancestor cannot wait for a foreign workspace lease; prepare the producer before payload admission', { cause: error });
        }
      } else {
        throw error;
      }
    }
    result = { status: 130, signal: null };
  } finally {
    observation?.observer.close();
    controls?.off('close', interrupt);
    controls?.close();
    controlInput?.destroy();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
  if (result.error && !cancellation.signal.aborted) throw result.error;
  process.exitCode = result.signal ? 128 + (constants.signals[result.signal] ?? 0) : result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runWorkspaceBuildAdmissionWorker(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
