import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  loadCliCommonWorkspacesModule,
} from '../../../scripts/workspaces/loadCliCommonWorkspacesModule.mjs';
import { ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault } from '../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveWorkspaceBundlePublicationMode } from '../../../scripts/workspaces/workspaceBundlePublication.mjs';
import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';
import { readBundledPluginPackageNames } from './build-owned/bundledPluginMembership.ts';
import {
  assertBundledPluginPackageCorrespondence,
} from './build-owned/bundledPluginPackageCorrespondence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = findRepoRoot(__dirname);

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

export { loadCliCommonWorkspacesModule };

function readJsonSync(path) {
  // Local helper to keep this script self-contained even when invoked against a sandbox repo.
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readBundledDependencyNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function resolveDeclaredBundledPluginWorkspacePackageNames({ repoRoot }) {
  // Canonical bundled membership has one owner (bundledPluginMembership.ts). This
  // used to be a second, similar-but-different package list; the guardrails below
  // keep their pack-specific failure messages while discovery is delegated.
  return [...readBundledPluginPackageNames(repoRoot)];
}

export async function bundleWorkspaceDeps(opts = {}) {
  // `repoRoot`/`happyCliDir` refer to the target repository we are bundling into.
  // In tests, this is a sandbox directory. The implementation helpers (cli-common workspaces)
  // must still be loaded from the *script* repo (this monorepo checkout), not from the sandbox.
  const targetRepoRoot = opts.repoRoot ?? SCRIPT_REPO_ROOT;
  const happyCliDir = opts.happyCliDir ?? resolve(targetRepoRoot, 'apps', 'cli');
  const lockPath = opts.lockPath ?? resolveCliSharedDepsBuildLockPath(targetRepoRoot);

  const baseEnv = opts.env ?? process.env;
  const publicationMode = opts.publicationMode ?? 'live';
  const forceArtifactWorkspaceBuilds = publicationMode === 'artifact';
  const ensureWorkspacePackagesBuiltByName = opts.ensureWorkspacePackagesBuiltByName
    ?? ensureWorkspacePackagesBuiltByNameDefault;
  const {
    bundleWorkspacePackagesWithRuntimeDependencies,
    resolveWorkspaceBundlesFromPackageJson,
  } = await loadCliCommonWorkspacesModule(
    SCRIPT_REPO_ROOT,
    baseEnv,
    ensureWorkspacePackagesBuiltByName,
    {
      includeDevDependencies: false,
      publicationMode,
    },
  );
  const readBundleInputs = () => {
    const hostPackageJsonPath = resolve(happyCliDir, 'package.json');
    const hostPackageJsonRaw = readJsonSync(hostPackageJsonPath);
    const bundledDependencyNames = readBundledDependencyNames(hostPackageJsonRaw);
    const runtimeDependencyNames = new Set(
      hostPackageJsonRaw?.dependencies
      && typeof hostPackageJsonRaw.dependencies === 'object'
      && !Array.isArray(hostPackageJsonRaw.dependencies)
        ? Object.keys(hostPackageJsonRaw.dependencies)
        : [],
    );

    // Guardrail: if plugin workspaces exist under `packages/plugins/*`, they must be explicitly
    // declared as bundled dependencies in `apps/cli/package.json`. Otherwise, they will not ship in
    // the packed artifact even if we can bundle them locally.
    const discoveredBundledPluginPackageNames = resolveDeclaredBundledPluginWorkspacePackageNames({
      repoRoot: targetRepoRoot,
    });
    const missingPluginPackages = discoveredBundledPluginPackageNames.filter(
      (packageName) => !bundledDependencyNames.includes(packageName),
    );
    if (missingPluginPackages.length > 0) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing bundled plugin workspace dependencies`,
          `These packages exist under packages/plugins/* but are not declared in apps/cli/package.json#bundledDependencies:`,
          ...missingPluginPackages.map((name) => `- ${name}`),
          ``,
          `Fix: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts --mode write`,
        ].join('\n'),
      );
    }
    const missingRuntimePluginPackages = discoveredBundledPluginPackageNames.filter(
      (packageName) => !runtimeDependencyNames.has(packageName),
    );
    if (missingRuntimePluginPackages.length > 0) {
      throw new Error(
        [
          `[bundle-workspace-deps] Missing CLI runtime dependencies for bundled plugin workspaces`,
          `These shippable packages must be declared in both apps/cli/package.json#bundledDependencies and #dependencies:`,
          ...missingRuntimePluginPackages.map((name) => `- ${name}`),
          ``,
          `Fix: node --experimental-strip-types scripts/migrations/extensions/syncCliBundledExtensionPackaging.ts --mode write`,
        ].join('\n'),
      );
    }

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot: targetRepoRoot,
      hostPackageDir: happyCliDir,
    });
    return { bundles, discoveredBundledPluginPackageNames };
  };
  const { bundles, discoveredBundledPluginPackageNames } = readBundleInputs();
  const bundledWorkspacePackageNames = [...new Set(
    bundles.map((bundle) => String(bundle?.packageName ?? bundle?.name ?? '').trim()).filter(Boolean),
  )];
  const generatorOwnedPluginPackageNames = forceArtifactWorkspaceBuilds
    ? new Set(discoveredBundledPluginPackageNames)
    : new Set();
    // `build:shared` is the natural prepack builder and owns the full force-build
    // followed by first-party plugin runtime publication. The pack-time copier must
    // not re-admit those canonical members to the ordinary
    // workspace compiler again: even a non-forced staleness check can replace the
    // staged bundle/chunk tree with compiler-owned reexports. The direct prepared-tree
    // correspondence check below is the admission check for those bytes.
  const workspacePackageNamesToForceBuild = bundledWorkspacePackageNames.filter(
    (packageName) => !generatorOwnedPluginPackageNames.has(packageName),
  );
  if (workspacePackageNamesToForceBuild.length > 0) {
    await ensureWorkspacePackagesBuiltByName(
      targetRepoRoot,
      workspacePackageNamesToForceBuild,
      {
        quiet: false,
        env: baseEnv,
        ...(opts.signal ? { signal: opts.signal } : {}),
        includeDevDependencies: false,
        publicationMode,
        ...(forceArtifactWorkspaceBuilds ? { force: true } : {}),
      },
    );
  }
  return withOptionalCliSharedDepsBuildLock(async () => {
    // Package preparation never runs under this copy lease. Re-read the real
    // manifest and guardrails after waiting, then copy through the immutable
    // prepared helper; missing prepared outputs fail in the canonical copier.
    const { bundles: currentBundles, discoveredBundledPluginPackageNames: currentPluginNames } = readBundleInputs();
    const currentGeneratorOwnedPluginPackageNames = forceArtifactWorkspaceBuilds ? new Set(currentPluginNames) : new Set();
    bundleWorkspacePackagesWithRuntimeDependencies({
      bundles: currentBundles.map((bundle) => (
        currentGeneratorOwnedPluginPackageNames.has(bundle.packageName)
          ? {
              ...bundle,
              validatePreparedPackage: ({ packageDir }) => {
                assertBundledPluginPackageCorrespondence({
                  packageName: bundle.packageName,
                  sourceDir: bundle.srcDir,
                  packageDir,
                });
              },
            }
          : bundle
      )),
      publicationMode,
    });
  }, {
    repoRoot: targetRepoRoot,
    lockPath,
    env: baseEnv,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onWait ? { onWait: opts.onWait } : {}),
    lockTimeoutMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
    lockPollIntervalMs: 250,
    lockStaleAfterMs: DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps({
      publicationMode: resolveWorkspaceBundlePublicationMode({
        argv: process.argv.slice(2),
        env: process.env,
      }),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
