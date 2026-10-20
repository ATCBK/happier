import { basename, join } from 'node:path';
import { runCommandStreaming } from '../../process/runCommandStreaming.js';
import { createHappierTempDir, removeHappierTempDirAsync } from '../../tempDirs/createHappierTempDir.js';

import { createScpReadyPayloadCopy } from './createScpReadyPayloadCopy.js';

export async function createScpReadyPayloadArchive(payloadRoot: string): Promise<Readonly<{
  archiveStageRoot: string;
  archiveFileName: string;
  extractedPayloadDirName: string;
  cleanup: () => Promise<void>;
}>> {
  const scpReadyPayload = await createScpReadyPayloadCopy(payloadRoot);
  const archiveStageRoot = createHappierTempDir({ purpose: 'first-party-scp-archive' });
  const extractedPayloadDirName = basename(scpReadyPayload.payloadRoot);
  const archiveFileName = `${extractedPayloadDirName}.tar.gz`;

  try {
    await runCommandStreaming({ cmd: 'tar', args: [
      '-czf',
      join(archiveStageRoot, archiveFileName),
      '-C',
      join(scpReadyPayload.payloadRoot, '..'),
      extractedPayloadDirName,
    ] });
    return {
      archiveStageRoot,
      archiveFileName,
      extractedPayloadDirName,
      cleanup: async () => {
        await Promise.all([
          scpReadyPayload.cleanup(),
          removeHappierTempDirAsync(archiveStageRoot),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      scpReadyPayload.cleanup(),
      removeHappierTempDirAsync(archiveStageRoot),
    ]);
    throw error;
  }
}
