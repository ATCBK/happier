import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

import {
  ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev as syncSharedDepsForSourceDevDefault,
} from '../../stack/scripts/utils/proc/pm.mjs';
import { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
export { verifyUiPatchedDependencies } from '../tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
export { retainBundledPluginUiArtifactsInventory } from './generateBundledPluginUiArtifacts.mjs';
import {
  generateBundledPluginUiArtifacts as generateBundledPluginUiArtifactsDefault,
  resolveBundledPluginUiArtifactsOutputPath,
  resolveBundledPluginUiArtifactsInputPaths,
} from './generateBundledPluginUiArtifacts.mjs';

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function publishBundledPluginProjectionWithFailures({ repoRoot, env, pluginFailures, publicationMode = 'live' }) {
  const { runCanonicalBundledPluginArtifactPublisher } = await import('../../cli/scripts/buildSharedDeps.mjs');
  await runCanonicalBundledPluginArtifactPublisher({
    repoRoot,
    env,
    mode: 'write',
    publicationMode,
    pluginFailures,
    // Failure admission updates the existing scoped inventory; it cannot replace
    // the complete shared Agent projection with an incomplete package set.
    ...(publicationMode === 'live' && pluginFailures.length > 0 ? {
      workspaceNames: pluginFailures.map((failure) => failure.packageName.replace(/^@happier-dev\//, '')),
      targetOwnedOnly: String(env?.HAPPIER_DEV_TARGET_EXECUTION ?? '').trim() === '1',
    } : {}),
  });
}

export function resolveUiWorkspaceStartupOutputs({
  uiPackageDir = uiDir,
  env = process.env,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  const inventoryPath = env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY || resolveBundledPluginUiArtifactsOutputPath(repoRoot);
  return resolveBundledPluginUiArtifactsInputPaths(inventoryPath) ?? [];
}

function readRebuiltBundledPluginWorkspaceNames(result) {
  const out = [];
  const seen = new Set();
  for (const rawPackageName of Array.isArray(result?.built) ? result.built : []) {
    if (typeof rawPackageName !== 'string') continue;
    const workspaceName = rawPackageName.trim().replace(/^@happier-dev\//, '');
    if (!workspaceName.startsWith('plugins-') || seen.has(workspaceName)) continue;
    seen.add(workspaceName);
    out.push(workspaceName);
  }
  return out;
}

export async function ensureUiWorkspacePackagesBuilt({
  env = process.env,
  publicationMode = 'live',
  uiPackageDir = uiDir,
  source = false,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
  syncSharedDepsForSourceDev = syncSharedDepsForSourceDevDefault,
  generateBundledPluginUiArtifacts = generateBundledPluginUiArtifactsDefault,
  publishBundledPluginProjectionWithFailuresImpl = publishBundledPluginProjectionWithFailures,
  verifyPatchedDependencies = verifyUiPatchedDependencies,
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  if (publicationMode !== 'live' && publicationMode !== 'artifact') {
    throw new Error(`Unknown UI workspace publication mode: ${publicationMode}`);
  }
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    env,
    buildMode: publicationMode === 'artifact' ? 'strict' : env[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev',
  }) };
  verifyPatchedDependencies({ uiPackageDir });
  if (source) {
    if (publicationMode !== 'live') throw new Error('Source Expo preparation cannot publish package artifacts');
    // Source worker compilation owns freshness and retained outputs separately
    // from installed dependency admission.
    const { resolveUiPostinstallTasks } = await import('../tools/resolveUiPostinstallTasks.mjs');
    const tasks = resolveUiPostinstallTasks({ env });
    const retainLastGreen = env.HAPPIER_STACK_DEV_READ_ONLY_DEPENDENCIES === '1';
    const { buildPasswordKdfWorker } = await import('../tools/password/buildPasswordKdfWorker.mjs');
    const { buildAtmosphereRenderers } = await import('../tools/atmosphere/buildAtmosphereRenderers.mjs');
    if (tasks.includes('vendor-password-kdf-worker')) await buildPasswordKdfWorker({ uiDirectory: uiPackageDir, retainLastGreen });
    if (tasks.includes('prepare-atmosphere-renderers')) await buildAtmosphereRenderers({ uiDirectory: uiPackageDir,
      web: tasks.includes('vendor-password-kdf-worker'), retainLastGreen });
    const { buildUiSourceAsset } = await import('../tools/sourceAsset.mjs');
    if (tasks.includes('vendor-tiptap-webview-bundle')) {
      const { buildTiptapWebViewBundle } = await import('../tools/tiptap/buildTiptapWebViewBundle.mjs');
      await buildUiSourceAsset({ retainLastGreen,
        outputs: [resolve(uiPackageDir, 'sources/components/ui/markdown/editor/bridge/tiptapWebViewBundle.generated.ts')],
        build: () => buildTiptapWebViewBundle({ expoAppDir: uiPackageDir, repoRootDir: repoRoot }) });
    }
    if (tasks.includes('vendor-mermaid-webview-bundle')) {
      const { buildMermaidWebViewBundle } = await import('../tools/mermaid/buildMermaidWebViewBundle.mjs');
      await buildUiSourceAsset({ retainLastGreen,
        outputs: [resolve(uiPackageDir, 'sources/components/markdown/mermaidWebViewBundle.generated.ts')],
        build: () => buildMermaidWebViewBundle({ expoAppDir: uiPackageDir }) });
    }
    const { prepareSourcePluginUiInventory } = await import('../../stack/scripts/build/build_source_web_ui.mjs');
    const requestedInventory = String(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY ?? '').trim();
    if (requestedInventory && !isAbsolute(requestedInventory)) {
      throw new Error('HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY must be an absolute path');
    }
    const parent = requestedInventory ? dirname(requestedInventory) : resolve(uiPackageDir, '.expo/hstack/plugin-ui-inputs');
    await mkdir(parent, { recursive: true });
    // Retain these bytes even if the worker is interrupted after publication.
    // Each consumer owns its inventory and inputs. Another preparation/export
    // must never replace Metro's inventory in the shared source tree.
    const outputDir = await mkdtemp(resolve(parent, 'preparation-'));
    const outputPath = requestedInventory || resolve(outputDir, 'inputs/inventory.js');
    await prepareSourcePluginUiInventory({ repoDir: repoRoot, outputDir, inventoryPath: outputPath, env });
    return { ok: true, built: [], skipped: [], outputPath };
  }
  const result = await ensureWorkspacePackagesBuiltForComponent(uiPackageDir, {
    quiet: false,
    env,
    publicationMode,
    isolatePluginFailures: publicationMode === 'live',
  });
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  if (skipped.includes('not-monorepo')) {
    throw new Error('[ui] ensure:workspace:built failed (not-monorepo): apps/ui must be run from inside the Happier monorepo checkout.');
  }
  const rebuiltPluginWorkspaceNames = readRebuiltBundledPluginWorkspaceNames(result);
  if (publicationMode === 'artifact' && result.pluginFailures?.length > 0) {
    throw new Error(`UI artifact publication failed for ${result.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  if (rebuiltPluginWorkspaceNames.length > 0 || result.pluginFailures?.length > 0) {
    // Expo adoption happens after this preflight returns. Feed the canonical
    // publisher only E2's actual rebuilt plugin set so it validates and
    // publishes one matching registry/artifact pair before Expo can resolve
    // those new package bytes.
    if (publicationMode === 'artifact') {
      await publishBundledPluginProjectionWithFailuresImpl({ repoRoot, env, pluginFailures: [], publicationMode });
    } else await syncSharedDepsForSourceDev(repoRoot, {
      env,
      includeRuntimeDependencies: true,
      quiet: false,
      workspaceNames: rebuiltPluginWorkspaceNames,
      ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
    });
  }
  const uiArtifacts = await generateBundledPluginUiArtifacts({
    repoRoot,
    mode: 'write',
    publicationMode,
    ...(result.pluginFailures?.length ? { pluginFailures: result.pluginFailures } : {}),
  });
  const inheritedFailures = result.pluginFailures ?? [];
  if (publicationMode === 'artifact' && (uiArtifacts?.pluginFailures?.length ?? 0) > 0) {
    throw new Error(`UI artifact publication failed for ${uiArtifacts.pluginFailures.map((failure) => failure.packageName).join(', ')}`);
  }
  const newlyFailedUiPlugins = (uiArtifacts?.pluginFailures ?? []).filter((failure) => (
    !inheritedFailures.some((inherited) => inherited.packageName === failure.packageName)
  ));
  if (newlyFailedUiPlugins.length > 0) {
    // The artifact reader runs after installed package publication. Reproject
    // every generated consumer, not only the manifest-only aggregate, before
    // the UI bundle can load static plugin imports.
    await publishBundledPluginProjectionWithFailuresImpl({
      repoRoot,
      env,
      pluginFailures: [...inheritedFailures, ...newlyFailedUiPlugins],
    });
  }
  return result;
}

async function run() {
  const expoIndex = process.argv.indexOf('--expo');
  if (expoIndex !== -1) {
    const { expoExec } = await import('../../stack/scripts/utils/expo/command.mjs');
    await expoExec({ dir: uiDir, args: process.argv.slice(expoIndex + 1), env: process.env });
    return;
  }
  await ensureUiWorkspacePackagesBuilt({
    publicationMode: process.argv.includes('--artifact') ? 'artifact' : 'live',
    source: !process.argv.includes('--artifact'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
