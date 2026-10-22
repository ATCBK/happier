import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** UI-first Node lookup, retaining all installed copies for native/Metro checks.
 * Use search paths rather than package.json exports: packages may hide their
 * manifest, and patch verification must also inspect shadowed ancestor copies.
 */
export function findUiInstalledPackageDirs(packageName, { uiPackageDir }) {
    const require = createRequire(path.resolve(uiPackageDir, 'package.json'));
    const packageDirs = new Set();
    for (const modulesDir of require.resolve.paths(packageName) ?? []) {
        const packageDir = path.join(modulesDir, packageName);
        if (fs.existsSync(packageDir)) packageDirs.add(fs.realpathSync(packageDir));
    }
    return [...packageDirs];
}
