/** @moduleRealm daemon */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createAbsolutePathSymlink } from './createAbsolutePathSymlink.js';

/** Links existing children into a real private directory without replacing destination entries. */
export async function linkDirectoryChildren(params: Readonly<{
  source: string;
  destination: string;
  exclude?: readonly string[];
}>): Promise<void> {
  await mkdir(params.destination, { recursive: true, mode: 0o700 });
  let entryNames: readonly string[];
  try {
    entryNames = await readdir(params.source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entryNames.map(async (entryName) => {
    if (params.exclude?.includes(entryName)) return;
    const source = join(params.source, entryName);
    let sourceStat;
    try {
      sourceStat = await stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      await createAbsolutePathSymlink({
        sourcePath: source,
        destinationPath: join(params.destination, entryName),
        sourceKind: sourceStat.isDirectory() ? 'directory' : 'file',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
  }));
}
