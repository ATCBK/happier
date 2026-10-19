import { stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { readSkillZipFilesV1 } from '@happier-dev/protocol/prompts/library/skills/skillZipV1';
import { readSkillDirectoryInputV1 } from './skillsDirectoryInputAdapter';
import type { SkillInstallSourceV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { z } from 'zod/mini';

export async function readSkillSourceArgV1(source: string): Promise<z.infer<typeof SkillInstallSourceV1Schema> | Readonly<{ kind: 'registryUnpinned'; sourceId: string; itemId: string }>> {
  if (/^https?:\/\//i.test(source)) return { kind: 'link', url: source };
  const path = resolve(expandHomeDirPath(source));
  const info = await stat(path).catch(error => { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (info?.isDirectory()) return { kind: 'upload', files: await readSkillDirectoryInputV1(path) };
  if (info?.isFile()) return { kind: 'upload', files: await readSkillZipFilesV1(await readFile(path)) };
  const separator = source.indexOf('/');
  if (separator < 1) throw Object.assign(new Error('Supply a registry/item, URL, folder or ZIP.'), { code: 'invalid_source' });
  return { kind: 'registryUnpinned', sourceId: source.slice(0, separator), itemId: source.slice(separator + 1) };
}
