import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { skillFileFromBytesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import type { SkillFileInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

/** File preparation only; validation, naming and mutation stay with the compiled Action. */
export async function readSkillDirectoryInputV1(directory: string): Promise<SkillFileInputV1[]> {
  const root = resolve(expandHomeDirPath(directory));
  const files: SkillFileInputV1[] = [];
  async function walk(path: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(path, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw Object.assign(new Error(`Cannot import symbolic link: ${relative}`), { code: 'unsupported_entry' });
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) files.push(skillFileFromBytesV1(relative, await readFile(absolute), stat.mode & 0o7777));
    }
  }
  await walk(root, ''); return files;
}
