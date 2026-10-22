import { join, resolve } from 'node:path';

import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { inspectDependencyRefresh, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { ensureUiPostinstallOutputs } from '../proc/pm.mjs';

// Worktree callers retain their frozen-lockfile/output policy, while dependency freshness,
// serialization, and successful refresh recording stay owned by the package-manager layer.
export async function shouldRunPnpmInstall({ installDir, componentDir }) {
  return (await inspectDependencyRefresh({ installDir, componentDir })).required;
}

export async function withPnpmInstallGuard({ installDir, componentDir = installDir, env = process.env, quiet = false }, install) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const uiDir = monorepoRoot && resolve(monorepoRoot) === resolve(installDir)
    ? join(monorepoRoot, 'apps', 'ui')
    : componentDir;
  let refreshed = false;
  return await withDependencyRefresh({
    installDir, componentDir, env,
    onDependenciesReady: () => ensureUiPostinstallOutputs(uiDir, installDir, { env, quiet, force: refreshed }),
  }, async ({ env: installEnv }) => {
    await install({ env: installEnv });
    // Complete lifecycle outputs after replacing dependency bytes.
    // Complete the same mandatory UI preparation as the PM refresh owner
    // before it publishes readiness for this installed tree.
    refreshed = true;
  });
}
