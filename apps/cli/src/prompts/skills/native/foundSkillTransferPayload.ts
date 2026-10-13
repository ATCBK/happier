import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { FoundSkillBundleV1Schema, type FoundSkillBundleV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import type { DownloadTransferSource } from '@happier-dev/transfers/node';
import { configuration } from '@/configuration';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';

export async function writeFoundSkillTransferPayload(input: FoundSkillBundleV1): Promise<DownloadTransferSource> {
  const payload = FoundSkillBundleV1Schema.parse(input);
  if (estimateJsonUtf8BytesBounded(payload, configuration.promptTransferJsonMaxBytes) > configuration.promptTransferJsonMaxBytes) {
    throw Object.assign(new Error('too_large'), { code: 'too_large' });
  }
  const body = JSON.stringify(payload);
  const sizeBytes = Buffer.byteLength(body, 'utf8');
  if (sizeBytes > configuration.promptTransferJsonMaxBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  const directory = createHappierTempDir({ purpose: 'found-skill-download' });
  const filePath = join(directory, 'skill.json');
  try { await writeFile(filePath, body, { encoding: 'utf8', mode: 0o600 }); }
  catch (error) { await removeHappierTempDirAsync(directory); throw error; }
  // The transfer owns its payload file; the marked directory belongs to the
  // existing temporary-storage cleanup owner after this process exits.
  return { filePath, deleteFileOnClose: true, sizeBytes, name: 'found-skill.json' };
}
