import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';
import paths from './dependency_version_paths.cjs';

const { mapDependencyVersionParent } = paths;
const versionRoot = process.env.HAPPIER_DEPENDENCY_VERSION_ROOT;

// Preloading is inherited by Node children and worker threads. Register once
// before application/config imports; no process-global resolver monkeypatch.
if (versionRoot) {
  const workspaceNames = new Set();
  for (const manifestPath of await collectWorkspacePackageJsonPaths(versionRoot)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest.name === 'string') workspaceNames.add(manifest.name);
  }
  let resolvingPhysicalRequire = false;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Authored paths, builtins, and package-import maps retain their source
      // owner. External package parents already inside A keep A's own layout.
      const bare = !isBuiltin(specifier) && !specifier.startsWith('.')
        && !specifier.startsWith('/') && !specifier.startsWith('#')
        && !/^[a-z][a-z0-9+.-]*:/iu.test(specifier);
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (resolvingPhysicalRequire || !bare || workspaceNames.has(packageName) || !context.parentURL?.startsWith('file:')) {
        return nextResolve(specifier, context);
      }
      const origin = fileURLToPath(context.parentURL);
      const parent = mapDependencyVersionParent(origin);
      // CommonJS carries its parent's precomputed lookup paths through the
      // default resolver; changing parentURL alone only redirects ESM. Resolve
      // require conditions from an actual physical parent, without reentering
      // this same mapping while createRequire performs the OS lookup.
      if (parent !== origin && context.conditions.includes('require')) {
        let resolved;
        resolvingPhysicalRequire = true;
        try { resolved = createRequire(pathToFileURL(parent)).resolve(specifier); }
        finally { resolvingPhysicalRequire = false; }
        return nextResolve(resolved, context);
      }
      return nextResolve(specifier, parent === origin ? context : { ...context, parentURL: pathToFileURL(parent).href });
    },
  });
}
