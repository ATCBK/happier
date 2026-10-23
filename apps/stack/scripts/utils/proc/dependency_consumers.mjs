import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { readJsonIfExists } from '../fs/json.mjs';
import { getDefaultAutostartPaths, getRepoDir, getStacksStorageRoot, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { resolveDependencyInstallRoot } from './dependency_refresh.mjs';
import { isPidAlive } from './pids.mjs';
import { resolveRemoteStackStorageDir } from '../dev_targets/stack_paths.mjs';
import { readEnvValueFromFile } from '../env/read.mjs';
import { hasLiveStackRuntimeProcesses } from '../stack/runtime_processes.mjs';

export const EXPO_DEPENDENCY_BARRIER_VERSION = 1;

function restartRequired(message) {
  const error = new Error(`${message} Stop the owning Stack once on this target, verify its recorded Expo process has exited, then start again. If ownership cannot be verified, inspect the recorded Expo state and process identity before stopping it.`);
  error.code = 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED';
  return error;
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// Existing Stack, pending-start and Expo state are the consumer inventory.
// Registration takes the dependency reader lease, so this inspection under
// writer custody cannot race a new consumer's publication. Pending starts
// refuse mutation; already-running runtimes supply restart advice only.
export async function prepareDependencyConsumersForRefresh({ installDir, env = process.env }) {
  const baseDirs = new Set(await directories(getStacksStorageRoot(env)));
  // Both remote bootstrap dispatchers provide cache=<targetHome>/cache even
  // when no running Stack env is inherited. Consume that same target context
  // through the managed Stack path owner, not the controller's default home.
  const targetCacheDir = String(env.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
  if (targetCacheDir) {
    for (const baseDir of await directories(resolveRemoteStackStorageDir(dirname(targetCacheDir)))) {
      baseDirs.add(baseDir);
    }
  }
  baseDirs.add(getDefaultAutostartPaths(env).baseDir);
  const explicitEnvFile = resolveExplicitStackEnvFilePath(env);
  if (explicitEnvFile) baseDirs.add(dirname(explicitEnvFile));
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim();
  const cliHomeDir = String(env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  const consumers = [];
  const stacksNeedingRestart = new Set();
  const seen = new Set();
  const targetRoot = resolve(installDir);
  for (const baseDir of baseDirs) {
    const envPath = explicitEnvFile && resolve(dirname(explicitEnvFile)) === resolve(baseDir)
      ? explicitEnvFile : join(baseDir, 'env');
    const repoDir = await readEnvValueFromFile(envPath, 'HAPPIER_STACK_REPO_DIR');
    if (repoDir && resolve(resolveDependencyInstallRoot(getRepoDir(baseDir, { ...env, HAPPIER_STACK_REPO_DIR: repoDir }))) === targetRoot) {
      const { readPendingSourcePreparation } = await import('../../runtime/shared/pending_source_start.mjs');
      const pending = await readPendingSourcePreparation({ stackBaseDir: baseDir });
      const state = await readJsonIfExists(join(baseDir, 'stack.runtime.json'));
      if (pending) {
        throw Object.assign(new Error(`Dependency refresh cannot rewrite the installed tree while Stack ${basename(baseDir)} is starting; retry after it reaches readiness.`),
          { code: 'HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS' });
      }
      if (isPidAlive(Number(state?.ownerPid)) || (state && hasLiveStackRuntimeProcesses(state))) {
        stacksNeedingRestart.add(basename(baseDir));
      }
    }
    for (const kind of ['expo-dev', 'mobile']) {
      for (const stateDir of await directories(join(baseDir, kind))) {
        const state = await readJsonIfExists(join(stateDir, 'expo.state.json'));
        const runnerDir = String(state?.uiDir ?? state?.projectDir ?? '').trim();
        if (!runnerDir || resolve(resolveDependencyInstallRoot(runnerDir)) !== targetRoot) continue;
        const pid = Number(state.pid);
        if (!Number.isInteger(pid) || pid <= 1 || !isPidAlive(pid) || seen.has(pid)) continue;
        const recordedFingerprint = String(state.processInstanceFingerprint ?? '').trim();
        if (!recordedFingerprint) {
          throw restartRequired(`Expo pid=${pid} has no verified dependency-safe restart owner.`);
        }
        // Stage-zero bootstrap can load without any workspace dist. A live
        // guarded runtime is the only path that needs its compiled OS adapter.
        const { readProcessInstanceFingerprintSync } = await import('@happier-dev/cli-common/processInstance');
        const fingerprint = readProcessInstanceFingerprintSync(pid, { expectedFingerprint: recordedFingerprint || null });
        if (recordedFingerprint && fingerprint && recordedFingerprint !== fingerprint) continue;
        // Discovery is dependency-wide, but termination authority belongs to
        // the caller's Stack. Borrowing each reader's recorded identity here
        // lets any installer stop unrelated serving stacks in this checkout.
        // Reject the shared mutation instead, before stopping any reader or
        // withdrawing its admitted dependency tree.
        if (!stackName || !explicitEnvFile || state.stackName !== stackName
          || !state.envPath || resolve(state.envPath) !== resolve(explicitEnvFile)) {
          throw restartRequired(`Dependency refresh cannot stop Expo pid=${pid} owned by another Stack (${state.stackName || 'unidentified'}).`);
        }
        // Old supervisors have already loaded an unguarded restart closure.
        // Never stop one and assume changing files retrofits that live owner.
        if (state.dependencyInstallBarrierVersion !== EXPO_DEPENDENCY_BARRIER_VERSION
          || !recordedFingerprint || !fingerprint) {
          throw restartRequired(`Expo pid=${pid} has no verified dependency-safe restart owner.`);
        }
        seen.add(pid);
        consumers.push({ pid, fingerprint });
      }
    }
  }
  // Validate every consumer before stopping any; a legacy sibling must reject
  // the whole mutation while every current reader still has its admitted tree.
  for (const { pid, fingerprint } of consumers) {
    const { killProcessGroupOwnedByStack } = await import('./ownership.mjs');
    const stopped = await killProcessGroupOwnedByStack(pid, {
      stackName,
      envPath: explicitEnvFile,
      cliHomeDir,
      label: 'Expo dependency consumer', json: true,
      processInstanceFingerprint: fingerprint,
    });
    if (!stopped.killed) {
      throw restartRequired(`Cannot stop verified Expo pid=${pid}: ${stopped.reason}.`);
    }
  }
  return { stacksNeedingRestart: [...stacksNeedingRestart].sort() };
}
