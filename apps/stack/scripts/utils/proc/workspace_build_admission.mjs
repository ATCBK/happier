import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { parseWorkspaceLockLeaseValue } from '../../../../../packages/cli-common/workspaceLockLease.mjs';

const workerPath = fileURLToPath(import.meta.url);
const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

async function hasInheritedWorkspaceLease(env) {
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
export async function runWorkspaceBuildAdmission({ command, args = [], locks = [], cwd = process.cwd(),
  repoDir = sourceRoot, launcherPath = resolve(repoDir, 'apps/stack/bin/hstack-exec'), env = process.env,
  signal, admissionClass = 'package-dist', admissionRequired = true, stdio = 'inherit', onStdout, onStderr }) {
  const invocation = process.platform === 'win32' || !admissionRequired
    ? { command: process.execPath, args: [workerPath, '--standalone', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args] }
    : { command: '/bin/sh', args: [launcherPath, '--heavyweight-admission', `--class=${admissionClass}`,
      `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
      `--workspace-locks=${JSON.stringify(locks)}`, '--', command, ...args] };
  return await new Promise(resolveResult => {
    const child = spawn(invocation.command, invocation.args, { cwd, env, signal, stdio });
    let stdout = '', stderr = '', error;
    child.stdout?.on('data', value => { stdout += value; onStdout?.(value); });
    child.stderr?.on('data', value => { stderr += value; onStderr?.(value); });
    child.once('error', value => { error = value; });
    child.once('close', (status, terminalSignal) => resolveResult({ status, signal: terminalSignal,
      ...(child.stdout ? { stdout } : {}), ...(child.stderr ? { stderr } : {}), ...(error ? { error } : {}) }));
  });
}

function parseLocks(raw) {
  const locks = JSON.parse(raw);
  if (!Array.isArray(locks)) throw new Error('Workspace admission requires a lock array');
  for (const lock of locks) {
    if (!lock || typeof lock.path !== 'string' || !lock.path.trim()
      || (lock.kind !== undefined && lock.kind !== 'workspace')) {
      throw new Error('Workspace admission requires canonical workspace lock paths');
    }
  }
  return locks;
}

async function withLocks(locks, env, signal, run, index = 0, wait = true) {
  if (index === locks.length) return await run(env);
  const lock = locks[index];
  let reportedWait = false;
  return await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const leases = env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES
      ? JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES) : [];
    if (!Array.isArray(leases) || leases.some(value => typeof value !== 'string')) {
      throw new Error('Workspace admission requires an array of existing lock leases');
    }
    return await withLocks(locks, { ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([...new Set([...leases, heldLockValue])]),
    }, signal, run, index + 1, wait);
  }, {
    lockPath: resolve(lock.path), env, signal, wait,
    onWait({ lockPath, owner }) {
      if (reportedWait) return;
      reportedWait = true;
      console.error(`[preferred-execution] waiting for ${lock.errorLabel ?? 'workspace bundle'}: ${lockPath} (holder pid=${owner?.pid ?? 'unknown'})`);
    },
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
      process.exitCode = await hasInheritedWorkspaceLease(process.env) ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      // Exit 1 means an authenticated lease is absent. A probe failure must
      // remain distinct so the native owner cannot treat it as permission.
      process.exitCode = 2;
    }
    return;
  }
  const [mode, rawLocks, launcherPath, admissionClass, delimiter, command, ...args] = argv;
  // Already-parsed launchers still invoke --worker. Keep that live transport
  // until those invocations retire; the current owner only uses --worker-try.
  if (!['--worker', '--worker-try', '--worker-inherited', '--standalone'].includes(mode) || delimiter !== '--' || !command) {
    throw new Error('Invalid workspace admission worker invocation');
  }
  const locks = parseLocks(rawLocks);
  const inheritedWorkspaceLease = await hasInheritedWorkspaceLease(process.env);
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
  controlInput = mode !== '--standalone' ? new Socket({ fd: 4, readable: true, writable: false }) : null;
  controls = controlInput ? createInterface({ input: controlInput }) : null;
  const lines = controls?.[Symbol.asyncIterator]();
  controls?.once('close', interrupt);
  let result = { status: 0, signal: null };
  try {
    await withLocks(locks, process.env, cancellation.signal, async env => {
      if (mode !== '--standalone') {
        writeSync(3, inheritedWorkspaceLease ? 'ready-inherited\n' : 'ready\n');
        const decision = await lines.next();
        if (decision.done || decision.value === 'release') return;
        if (decision.value !== 'run') throw new Error('Invalid workspace admission decision');
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
      cancellation.signal.throwIfAborted();
      const invocation = mode === '--standalone'
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
    }, 0, mode === '--standalone' || mode === '--worker');
  } catch (error) {
    if (!cancellation.signal.aborted) {
      if (error?.code === WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE) {
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
