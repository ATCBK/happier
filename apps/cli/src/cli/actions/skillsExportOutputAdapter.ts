import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

export async function writeSkillExportOutputV1(output: unknown, path: string): Promise<void> {
  const archive = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.export'].parse(output);
  await writeFile(resolve(expandHomeDirPath(path)), decodeBase64(archive.bytes, 'base64'), { flag: 'wx' });
}
