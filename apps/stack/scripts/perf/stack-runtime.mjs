import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export function readPerfStackRuntime({ stackBaseDir, stack }) {
  const root = resolve(stackBaseDir);
  if (basename(root) !== stack || !/^agent-qa-[a-zA-Z0-9._-]+$/.test(stack)) {
    throw new Error('Capture requires its exact named QA stack directory');
  }
  const path = join(root, 'stack.runtime.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
