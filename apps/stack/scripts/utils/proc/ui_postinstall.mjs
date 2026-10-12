import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectUiPostinstallOutputs(componentDir, installDir, { env = process.env } = {}) {
  const manifestPath = join(componentDir, 'package.json');
  if (!existsSync(manifestPath)) return [];
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pkg?.name !== '@happier-dev/app' || typeof pkg?.scripts?.['postinstall:real'] !== 'string') return [];

  const verifierPath = join(componentDir, 'tools', 'postinstall', 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs');
  if (existsSync(verifierPath)) {
    const { verifyUiPatchedDependencies } = await import(pathToFileURL(verifierPath).href);
    const failures = [];
    try {
      verifyUiPatchedDependencies({ uiPackageDir: componentDir });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const tasksPath = join(componentDir, 'tools', 'resolveUiPostinstallTasks.mjs');
    if (existsSync(tasksPath)) {
      const { resolveUiPostinstallTasks } = await import(pathToFileURL(tasksPath).href);
      const tasks = resolveUiPostinstallTasks({ env });
      // These producers are mandatory. Other vendored editors/workers retain
      // their postinstall owner's explicit best-effort/fallback contract.
      const required = [
        ...(tasks.includes('setup-skia-web') ? ['public/canvaskit.wasm'] : []),
      ];
      for (const path of required) {
        const output = join(componentDir, path);
        const info = await stat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info?.isFile() || info.size === 0) failures.push(`Missing or empty UI postinstall asset: ${output}`);
      }
    }
    return failures;
  }
  // Installed/non-checkout contexts may not carry the source verifier.
  const packageDirs = [...new Set([
    join(componentDir, 'node_modules', 'react-native-enriched-markdown'),
    join(installDir, 'node_modules', 'react-native-enriched-markdown'),
  ])].filter(dir => existsSync(dir));
  if (packageDirs.length === 0) packageDirs.push(join(componentDir, 'node_modules', 'react-native-enriched-markdown'));
  return packageDirs.map(dir => join(dir, 'lib', 'module', 'web', 'streamingReveal.js')).filter(file => !existsSync(file));
}

// Both stage-zero/source-test installs and full PM preparation consume this
// owner. It must load before cli-common or other workspace dist exists.
export async function ensureUiPostinstallOutputs(componentDir, installDir, {
  quiet = false,
  force = false,
  env = process.env,
  runPostinstall,
  restoreDependencies,
} = {}) {
  const manifestPath = join(componentDir, 'package.json');
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (pkg?.name !== '@happier-dev/app' || typeof pkg?.scripts?.['postinstall:real'] !== 'string') return;
  if (!force && (await inspectUiPostinstallOutputs(componentDir, installDir, { env })).length === 0) return;
  if (!quiet) console.log('[local] repairing happier-ui postinstall outputs...');
  const postinstallEnv = { ...env, HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '1' };
  try {
    await runPostinstall(postinstallEnv);
  } catch {
    // Changed patch inputs can leave a mixed tree. Re-extract pristine bytes
    // through the caller's PM adapter, then retry the same UI postinstall.
    if (!quiet) console.log('[local] repairing mixed happier-ui patched dependency bytes...');
    await restoreDependencies();
    await runPostinstall(postinstallEnv);
  }
  const failures = await inspectUiPostinstallOutputs(componentDir, installDir, { env });
  if (failures.length > 0) {
    throw new Error(`[local] happier-ui postinstall completed without satisfying patched dependency readiness:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
  }
}
