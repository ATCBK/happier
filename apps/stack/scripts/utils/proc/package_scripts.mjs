import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export async function detectPackageManagerCmd(dir) {
  // Stack source package scripts always use the repository's pinned manager.
  return { name: 'pnpm', cmd: 'pnpm', argsForScript: (script) => ['run', '--silent', script] };
}

export async function readPackageJsonScripts(dir) {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return null;
  }
}

export function pickFirstScript(scripts, candidates) {
  if (!scripts) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  return list.find((k) => typeof scripts[k] === 'string' && scripts[k].trim()) ?? null;
}
