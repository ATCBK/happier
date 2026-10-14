import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { FoundSkillDownloadRequestV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';

import { resolveFoundSkillDownloadSource } from '@/prompts/skills/native/resolveFoundSkillDownloadSource';
import type { DirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createFileTransferPayloadSource } from './transferPayloadSource';

/** Publish the scanner-authorized Found bundle through the incumbent export lifecycle. */
export async function prepareFoundSkillExport(params: Readonly<{
  lifecycle: Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady'>;
  request: FoundSkillDownloadRequestV1;
  signal?: AbortSignal;
}>) {
  const resolvedSource = await resolveFoundSkillDownloadSource({
    request: params.request,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!resolvedSource.success) {
    throw Object.assign(new Error(resolvedSource.error), {
      ...('code' in resolvedSource ? { code: resolvedSource.code } : {}),
    });
  }
  const sourceOffsetBytes = 'sourceOffsetBytes' in resolvedSource.source
    && typeof resolvedSource.source.sourceOffsetBytes === 'number'
    ? resolvedSource.source.sourceOffsetBytes
    : undefined;
  const payloadSource = createFileTransferPayloadSource({
    filePath: resolvedSource.source.filePath,
    sizeBytes: resolvedSource.source.sizeBytes,
    name: resolvedSource.source.name,
    dispose: resolvedSource.source.deleteFileOnClose
      ? async () => {
          await rm(resolvedSource.source.filePath, { force: true }).catch(() => undefined);
        }
      : undefined,
    ...(typeof sourceOffsetBytes === 'number' ? { sourceOffsetBytes } : {}),
  });
  const published = await params.lifecycle.publishTransferWhenReady({
    transferId: `prompt-asset-download:${randomUUID()}`,
    payloadSource,
  });
  return {
    transferId: published.transferId,
    endpointCandidates: published.endpointCandidates,
    expiresAt: published.expiresAt,
    name: resolvedSource.source.name,
    sizeBytes: resolvedSource.source.sizeBytes,
  };
}
