import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveTypecheckProjects, prepareDerivedTypecheckProjects } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const sourceNames = ['foundation', 'core', 'source'];
const testNames = ['test-components', 'test-other'];
const names = [...sourceNames, ...testNames];

function prepareUiTypedRoutes(packageDir) {
  const require = createRequire(resolve(packageDir, 'package.json'));
  const { exp } = require('expo/config').getConfig(packageDir, {
    skipSDKVersionRequirement: true, skipPlugins: true,
  });
  if (exp.experiments?.typedRoutes !== true) return;
  // Resolve Expo's private generator through the SDK's declared dependency
  // closure, so preparation uses the same installed versions as Expo CLI.
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const { getRouterDirectoryModuleIdWithManifest } = cliRequire('./build/src/start/server/metro/router');
  const appRoot = resolve(packageDir, getRouterDirectoryModuleIdWithManifest(packageDir, exp));
  const { requireContext } = require('expo-router/internal/testing');
  const { EXPO_ROUTER_CTX_IGNORE } = require('expo-router/_ctx-shared');
  const context = requireContext(appRoot, true, EXPO_ROUTER_CTX_IGNORE);
  const { resolver } = require(resolve(packageDir, 'metro.config.js'));
  const blockList = Array.isArray(resolver.blockList) ? resolver.blockList : [resolver.blockList];
  for (const key of context.keys()) {
    if (blockList.some(rule => rule instanceof RegExp && rule.test(resolve(appRoot, key)))) context.__delete(key);
  }
  // Finite compilation needs the completed declaration now, not Expo's
  // watcher debounce. Use the exact generator underlying regenerateDeclarations.
  const { getTypedRoutesDeclarationFile } = cliRequire('@expo/router-server/build/typed-routes/generate');
  const declaration = getTypedRoutesDeclarationFile(context, exp.extra?.router);
  // Expo's live watcher owns .expo/types/router.d.ts and can regenerate it
  // while finite programs compile. Keep this input with the finite configs.
  const outputDir = resolve(packageDir, 'node_modules/.cache/tsc');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'router.d.ts');
  const temporaryPath = resolve(outputDir, `.router.${process.pid}.tmp`);
  writeFileSync(temporaryPath, declaration);
  renameSync(temporaryPath, outputPath);
  process.stderr.write(`[typescript] prepared UI typed routes: ${outputPath}\n`);
  return { declarationOverrides: new Map([[resolve(packageDir, '.expo/types/router.d.ts'), outputPath]]) };
}


export function deriveUiTypecheckProjects(packageDir, options = {}) {
  return deriveTypecheckProjects(packageDir, {
    sourceNames, testNames,
    testGroup: path => path.startsWith('sources/components/') ? 0 : 1,
    ...options,
  });
}

export async function prepareUiTypecheckProjects(projects, cwd) {
  return prepareDerivedTypecheckProjects(projects, cwd, {
    names: projects.length === sourceNames.length ? sourceNames : names,
    derive: packageDir => deriveUiTypecheckProjects(packageDir, prepareUiTypedRoutes(packageDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const writeAuthored = process.argv.includes('--write-authored');
  console.log(JSON.stringify(await deriveUiTypecheckProjects(packageDir, {
    ...(!writeAuthored ? prepareUiTypedRoutes(packageDir) : {}),
    check: process.argv.includes('--check'), writeAuthored,
  })));
}
