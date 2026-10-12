import { join } from 'node:path';
import { createHappierTempDir } from '../tempDirs/createHappierTempDir.js';

export async function createManagedToolScratchDir(params: Readonly<{
  installDir: string;
  prefix: string;
}>): Promise<string> {
  const installDir = String(params.installDir ?? '').trim();
  const prefix = String(params.prefix ?? '').trim();
  if (!installDir) {
    throw new Error('[managed-tool] installDir is required');
  }
  if (!prefix) {
    throw new Error('[managed-tool] prefix is required');
  }

  const scratchRoot = join(installDir, '.tmp');
  return createHappierTempDir({ purpose: prefix, root: scratchRoot });
}
