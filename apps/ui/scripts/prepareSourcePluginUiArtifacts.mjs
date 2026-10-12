import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniversalPluginUiArtifacts } from '../../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts';
import { generateBundledPluginUiArtifacts, resolveBundledPluginUiArtifactsRetainedRoots,
  resolveBundledPluginUiArtifactsOutputPath, collectBundledPluginUiArtifactSources } from './generateBundledPluginUiArtifacts.mjs';
import { createBundledPluginPublicationFailure } from '../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { readSourcePluginUiBuildInputs } from '../../stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { readBuildInputIdentity } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '../../../packages/cli-common/packageBuildOutputTargets.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../../stack/scripts/utils/fs/json.mjs';
import { resolveDependencyRefreshMarkerPath } from '../../stack/scripts/utils/proc/dependency_refresh.mjs';

/** Reuse the universal UI artifact compiler and inventory owner without publishing
 * package dist or compiler projections. Callers publish a consumer-owned inventory
 * beside retained input roots, never the shared source-tree projection. */
export async function prepareSourcePluginUiArtifacts({ repoRoot, outputDir, plugins, resolveSourceImport, sourceImportConditions = [], artifactOutputDirs = {}, outputPath = join(outputDir, 'inventory.js') }) {
  const artifactRoots = {};
  const pluginManifests = {};
  const compilationFailures = [];
  const retainedRoots = resolveBundledPluginUiArtifactsRetainedRoots(outputPath);
  const producerRoots = resolveBundledPluginUiArtifactsRetainedRoots(resolveBundledPluginUiArtifactsOutputPath(repoRoot));
  const compilerRepo = fileURLToPath(new URL('../../../', import.meta.url));
  const compilerFiles = await readSourcePluginUiBuildInputs({ repoDir: compilerRepo, compiler: true });
  const compilerIdentity = await readBuildInputIdentity({ sourceDir: compilerRepo, files: compilerFiles });
  const esbuildVersion = createRequire(join(compilerRepo, 'packages/plugin-sdk/package.json'))('esbuild/package.json').version;
  const dependencyInputs = await readJsonIfExists(resolveDependencyRefreshMarkerPath(compilerRepo));
  const packages = await readWorkspacePackages(repoRoot);
  const successfulInputs = new Map();
  await mkdir(outputDir, { recursive: true });
  for (const { directory, manifest, uiArtifacts = true } of plugins) {
    pluginManifests[directory] = manifest;
    if (!uiArtifacts) continue;
    const manifestPath = join(outputDir, `${directory}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const projectRoot = join(repoRoot, 'packages/plugins', directory);
    const artifactOutputDir = artifactOutputDirs[directory] ?? join(outputDir, directory, 'happier-plugin-ui');
    const candidates = [...new Set([artifactOutputDir, retainedRoots.get(manifest.id),
      producerRoots.get(manifest.id), join(projectRoot, 'dist/happier-plugin-ui')].filter(Boolean))];
    try {
      const files = await readSourcePluginUiBuildInputs({ repoDir: repoRoot, pluginDirectory: directory, packages });
      const options = [manifest, compilerIdentity, esbuildVersion, dependencyInputs, sourceImportConditions, 'happier-source', process.version, process.platform, process.arch];
      const inputFingerprint = await readBuildInputIdentity({ sourceDir: repoRoot, files, options });
      for (const root of candidates) {
        const record = await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
        if (record?.version !== 2 || record.fingerprint !== inputFingerprint) continue;
        const retained = await collectBundledPluginUiArtifactSources(repoRoot, [], { [directory]: root }, { [directory]: manifest });
        if (retained.pluginFailures.length > 0) continue;
        artifactRoots[directory] = root;
        break;
      }
      if (artifactRoots[directory]) {
        successfulInputs.set(directory, { options, inputFingerprint });
        continue;
      }
      const { artifactsRoot } = await buildUniversalPluginUiArtifacts(projectRoot, manifestPath,
        { outputDir: artifactOutputDir, exportConditions: ['happier-source'], resolveSourceImport });
      artifactRoots[directory] = artifactsRoot;
      successfulInputs.set(directory, { options, inputFingerprint });
    } catch (error) {
      compilationFailures.push(createBundledPluginPublicationFailure({ repoRoot,
        packageName: `@happier-dev/plugins-${directory}`, pluginId: manifest.id,
        code: 'plugin_ui_artifact_invalid', error }));
      // The compiler leaves prior publications intact. The inventory owner
      // selects only a candidate whose manifest and complete graph validate.
      artifactRoots[directory] = candidates;
      // Finite runtime construction collects these roots even when UI is
      // unavailable. Absence of a manifest keeps artifact admission closed.
      await mkdir(artifactOutputDir, { recursive: true });
    }
  }
  const result = await generateBundledPluginUiArtifacts({
    repoRoot, outputPath, artifactRoots, artifactOutputDirs,
    pluginManifests, compilationFailures, publicationMode: 'source',
  });
  for (const [directory, input] of successfulInputs) {
    if (result.pluginFailures.some((failure) => failure.packageName === `@happier-dev/plugins-${directory}`)) continue;
    // An interactive source edit during compilation does not make the served
    // graph unusable, but it cannot certify unchanged-input reuse next time.
    const files = await readSourcePluginUiBuildInputs({ repoDir: repoRoot, pluginDirectory: directory, packages });
    if (await readBuildInputIdentity({ sourceDir: repoRoot, files, options: input.options }) !== input.inputFingerprint) continue;
    const root = artifactOutputDirs[directory] ?? artifactRoots[directory];
    const record = await readJsonIfExists(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD));
    if (record?.version === 2 && record.fingerprint === input.inputFingerprint) continue;
    await writeJsonAtomic(join(root, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), { version: 2, fingerprint: input.inputFingerprint });
  }
  for (const diagnostic of result.diagnostics) {
    const unavailable = result.pluginFailures.some((failure) => failure.pluginId === diagnostic.pluginId);
    console.error(`[plugin:${diagnostic.pluginId}] ${diagnostic.code}: ${diagnostic.message} (${unavailable ? 'UI unavailable' : 'serving last-green UI'})`);
  }
  return result;
}

// Native construction invokes this same compiler/inventory owner as source QA,
// with package-local outputs. Only build tooling uses the source preload.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input);
  const packages = await readWorkspacePackages(options.repoRoot);
  const sourceImportConditions = ['react-native', 'browser'];
  await prepareSourcePluginUiArtifacts({...options,sourceImportConditions,resolveSourceImport(specifier) {
    return packages.has(packageNameOfSpecifier(specifier))
      ? resolveWorkspaceSource(packages,specifier,{conditions:sourceImportConditions}) : undefined;
  }});
}
