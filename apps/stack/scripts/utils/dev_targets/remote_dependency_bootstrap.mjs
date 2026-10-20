import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execYarn } from '../../../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveRemoteValidationPreparationEnv } from './remote_validation_preparation.mjs';
import { assertDependenciesReady, SCRIPTLESS_DEPENDENCY_INSTALL_MODE, withDependencyConsumption, withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { ensureUiPostinstallOutputs } from '../proc/ui_postinstall.mjs';
import { resolvePackageManagerCachePaths } from '../proc/package_manager_cache.mjs';

export const REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS = [
  'install',
  '--production=false',
  '--ignore-engines',
  '--ignore-scripts',
  '--pure-lockfile',
];

function resolveInitialInstallEnv(env) {
  const resolved = {
    ...(env ?? process.env),
    NODE_ENV: 'development',
    YARN_PRODUCTION: '0',
    npm_config_production: 'false',
    NPM_CONFIG_PRODUCTION: 'false',
    COREPACK_ENABLE_AUTO_PIN: '0',
  };
  const cacheBaseDir = String(resolved.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
  if (cacheBaseDir) {
    for (const [key, path] of Object.entries(resolvePackageManagerCachePaths(cacheBaseDir))) resolved[key] ||= path;
  }
  return resolved;
}

async function installInitialDependencies({ repoDir, env }) {
  const installEnv = resolveInitialInstallEnv(env);
  for (const path of [
    installEnv.XDG_CACHE_HOME,
    installEnv.YARN_CACHE_FOLDER,
    installEnv.npm_config_cache,
    installEnv.COREPACK_HOME,
  ]) {
    if (path) await mkdir(path, { recursive: true });
  }
  execYarn(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, {
    cwd: repoDir,
    env: installEnv,
    preferCorepack: true,
    stdio: 'inherit',
  });
}

async function prepareInitialUiOutputs({ repoDir, env, force }) {
  const installEnv = resolveInitialInstallEnv(env);
  const runYarn = (args, postinstallEnv = installEnv) => execYarn(args, { cwd: repoDir, env: postinstallEnv, preferCorepack: true, stdio: 'inherit' });
  await ensureUiPostinstallOutputs(join(repoDir, 'apps', 'ui'), repoDir, {
    force, env: installEnv,
    runPostinstall: async (postinstallEnv) => runYarn(['-s', 'workspace', '@happier-dev/app', 'postinstall:real'], postinstallEnv),
    restoreDependencies: async () => runYarn(['install', '--force', ...REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS.slice(1)]),
  });
}

// A provisioner that already ran the canonical frozen install with lifecycle
// scripts (CI's prepare job) records that installed tree's admission here,
// through the same refresh owner and mutation lock, without reinstalling.
// Later local validation then proves freshness against the recorded inputs.
export async function adoptInstalledDependencies({
  repoDir = resolve(process.cwd()),
  env = process.env,
  withDependencyRefresh: withDependencyRefreshImpl = withDependencyRefresh,
} = {}) {
  if (!existsSync(join(repoDir, 'node_modules'))) {
    throw new Error(`[local] cannot adopt dependencies at ${repoDir}: node_modules is missing`);
  }
  return await withDependencyRefreshImpl(
    {
      installDir: repoDir,
      componentDir: join(repoDir, 'apps', 'stack'),
      env,
      onDependenciesReady: async () => await prepareInitialUiOutputs({ repoDir, env, force: false }),
    },
    async () => {},
  );
}

export async function bootstrapRemoteDependencies({
  repoDir = resolve(process.cwd()),
  validationKind = 'runtime',
  toolsOnly = false,
  componentRelativeDir = '.',
  executionPlacement = 'local',
  defaultBuildMode = validationKind === 'runtime' ? 'source-dev' : 'strict',
  env = process.env,
  packageExists = existsSync,
  installInitialDependencies: installInitialDependenciesImpl = installInitialDependencies,
  withDependencyRefresh: withDependencyRefreshImpl = withDependencyRefresh,
  loadWorkspaceBuildOwner = async () => await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'),
  loadDependencyOwner = async () => await import('../proc/pm.mjs'),
} = {}) {
  // Runtime preparation emits executable prerequisites. Semantic checking is
  // owned by explicit strict/publication callers and the separate check lane.
  env = resolveRemoteValidationPreparationEnv(env, validationKind, defaultBuildMode);
  const componentDir = join(repoDir, 'apps', 'stack');
  const componentPath = posix.normalize(String(componentRelativeDir).replaceAll('\\', '/'));
  const sourceToolsOnly = toolsOnly || validationKind === 'source-test' || validationKind === 'typecheck';
  // Only an affirmative worker placement permits dependency mutation.
  if (executionPlacement !== 'remote') {
    await assertDependenciesReady({ installDir: repoDir, componentDir, env,
      ...(sourceToolsOnly ? { installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE } : {}) });
    if (!sourceToolsOnly && /^apps\/stack(?:\/|$)/u.test(componentPath)) {
      const { ensureWorkspacePackagesBuiltForComponent } = await loadDependencyOwner();
      await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
    }
    return;
  }
  let refreshed = false;
  const installAndPrepare = async () => {
    await installInitialDependenciesImpl({ repoDir, env });
    refreshed = true;
  };
  // Every role reads the same installed tree. Complete the canonical UI
  // postinstall under its mutation lock, including warm trees with lost patches.
  // A healthy warm tree is inspected without rewriting dependency bytes.
  const onDependenciesReady = async () => await prepareInitialUiOutputs({ repoDir, env, force: refreshed });
  if (sourceToolsOnly) {
    // Warm validation is a reader. Queuing a writer for every readiness check
    // withdraws admission repeatedly and starves finite consumers behind work
    // that never installs anything. Recheck under the existing shared custody;
    // release it before requesting an actual installation or output repair.
    try {
      await withDependencyConsumption({ installDir: repoDir, env }, async () => {
        await assertDependenciesReady({ installDir: repoDir, componentDir, env,
          installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE });
      });
      return { refreshed: false, reason: 'up-to-date' };
    } catch (error) {
      if (error?.code !== 'HAPPIER_DEPENDENCIES_NEED_REFRESH') throw error;
    }
    // Source validation does not consume the Stack owner's compiled closure.
    // Typecheck compilers read published declarations and prepare their own
    // project declarations without acquiring workspace publication leases.
    // The readiness verifier and postinstall tools resolve source directly;
    // retain patched dependency preparation without publishing workspace dist.
    return await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE, onDependenciesReady },
      installAndPrepare,
    );
  }
  const dependencyOwnerEntrypoints = ['workspaces', 'process'].map((domain) => join(
    repoDir,
    'packages',
    'cli-common',
    'dist',
    domain,
    'index.js',
  ));
  const dependencyOwnerReady = dependencyOwnerEntrypoints.every((entrypoint) => packageExists(entrypoint));
  if (!dependencyOwnerReady) {
    await withDependencyRefreshImpl(
      { installDir: repoDir, componentDir, env, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE, onDependenciesReady },
      installAndPrepare,
    );
    const { ensureWorkspacePackagesBuiltByName } = await loadWorkspaceBuildOwner();
    await ensureWorkspacePackagesBuiltByName(
      repoDir,
      ['@happier-dev/cli-common'],
      { env, includeDevDependencies: false },
    );
  }

  const {
    ensureDepsInstalled,
    ensureWorkspacePackagesBuiltForComponent,
  } = await loadDependencyOwner();
  await ensureDepsInstalled(
    componentDir,
    'remote Happier workspace',
    { env },
  );
  // The launcher needs its dependency owner, while only Stack commands consume
  // Stack's emitted workspace closure. Other components prepare their own outputs.
  if (/^apps\/stack(?:\/|$)/u.test(componentPath)) {
    if (typeof ensureWorkspacePackagesBuiltForComponent !== 'function') {
      throw new Error('Remote Happier workspace dependency owner does not expose component workspace preparation');
    }
    await ensureWorkspacePackagesBuiltForComponent(componentDir, { env });
  }
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  if (process.argv.includes('--adopt-installed')) {
    const adoptRepo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
    await adoptInstalledDependencies(adoptRepo ? { repoDir: resolve(adoptRepo.slice('--repo-dir='.length)) } : {});
    process.exit(0);
  }
  const kind = process.argv.slice(2).find(value => value.startsWith('--validation-kind='));
  const component = process.argv.slice(2).find(value => value.startsWith('--component-relative-dir='));
  const repo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
  const placement = process.argv.slice(2).find(value => value.startsWith('--execution-placement='));
  const buildMode = process.argv.slice(2).find(value => value.startsWith('--default-build-mode='));
  await bootstrapRemoteDependencies({
    ...(repo ? { repoDir: resolve(repo.slice('--repo-dir='.length)) } : {}),
    toolsOnly: process.argv.includes('--tools-only'),
    validationKind: kind?.slice('--validation-kind='.length) ?? 'runtime',
    componentRelativeDir: component?.slice('--component-relative-dir='.length) ?? '.',
    executionPlacement: placement?.slice('--execution-placement='.length) ?? 'local',
    ...(buildMode ? { defaultBuildMode: buildMode.slice('--default-build-mode='.length) } : {}),
  });
}
