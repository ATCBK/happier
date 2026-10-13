import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveTypecheckProjects, prepareDerivedTypecheckProjects } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const sourceNames = ['foundation', 'services', 'core', 'source'];
const testNames = ['test'];
const names = [...sourceNames, ...testNames];

export function deriveCliTypecheckProjects(packageDir, options = {}) {
  return deriveTypecheckProjects(packageDir, { sourceNames, testNames, ...options });
}

export function prepareCliTypecheckProjects(projects, cwd) {
  return prepareDerivedTypecheckProjects(projects, cwd, { names, derive: deriveCliTypecheckProjects });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  console.log(JSON.stringify(await deriveCliTypecheckProjects(packageDir, {
    check: process.argv.includes('--check'), writeAuthored: process.argv.includes('--write-authored'),
  })));
}
