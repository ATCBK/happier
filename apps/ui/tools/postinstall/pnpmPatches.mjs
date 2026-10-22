import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/** Read the package manager's patch authority; postinstall never applies patches. */
export function readPnpmPatches(repoRootDir) {
    const workspace = parse(fs.readFileSync(path.join(repoRootDir, 'pnpm-workspace.yaml'), 'utf8'));
    return Object.entries(workspace.patchedDependencies ?? {}).map(([specifier, patchFile]) => ({
        packageName: specifier.slice(0, specifier.lastIndexOf('@')),
        patchFile: path.resolve(repoRootDir, patchFile),
    }));
}
