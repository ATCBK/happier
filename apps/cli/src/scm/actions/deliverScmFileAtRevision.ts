import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/protocol/actions/externalActionLimits';
import type { ScmFileAtRevisionRequest, ScmFileAtRevisionResponse, ScmFileReadResponse } from '@happier-dev/protocol/scm';
import type { FilesystemDownloadOutput } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { createFileTransferPayloadSource, resolveTransferPayloadManifestHash } from '@/machines/transfer/transferPayloadSource';

export type ScmFileBytesExportInput = Readonly<{ bytes: Uint8Array; name: string; signal?: AbortSignal }>;
type PreparedExport = Extract<FilesystemDownloadOutput, { success: true; status: 'accepted' }>['prepared'];
type ExportLifecycle = Pick<DirectTransferServerLifecycle, 'publishTransferWhenReady' | 'clearPublishedTransfer'>;

/** One disposable byte publisher for revision reads and review Undo pre-images. */
export async function prepareScmFileBytesExport(params: ScmFileBytesExportInput & Readonly<{
    lifecycle: ExportLifecycle;
}>): Promise<PreparedExport> {
    const directory = createHappierTempDir({ purpose: 'scm-file-bytes-export' });
    try {
        params.signal?.throwIfAborted();
        const filePath = join(directory, 'content');
        await writeFile(filePath, params.bytes, { mode: 0o600 });
        params.signal?.throwIfAborted();
        const payloadSource = createFileTransferPayloadSource({ filePath, sizeBytes: params.bytes.byteLength, name: params.name,
            dispose: () => removeHappierTempDirAsync(directory) });
        const manifestHash = await resolveTransferPayloadManifestHash(payloadSource);
        params.signal?.throwIfAborted();
        const published = await params.lifecycle.publishTransferWhenReady({ transferId: `scm-file-read:${randomUUID()}`, payloadSource: { ...payloadSource, manifestHash } });
        if (params.signal?.aborted) {
            params.lifecycle.clearPublishedTransfer(published.transferId);
            params.signal.throwIfAborted();
        }
        return { transferId: published.transferId, endpointCandidates: [...published.endpointCandidates],
            expiresAt: published.expiresAt, name: params.name, sizeBytes: params.bytes.byteLength, manifestHash };
    } catch (error) {
        await removeHappierTempDirAsync(directory);
        throw error;
    }
}

/** Delivery belongs to the host; in-process SCM consumers retain the complete bytes. */
export async function deliverScmFileAtRevision(params: Readonly<{
    request: ScmFileAtRevisionRequest;
    response: ScmFileAtRevisionResponse;
    lifecycle?: ExportLifecycle;
    signal?: AbortSignal;
}>): Promise<ScmFileReadResponse> {
    const response = params.response;
    if (!response.success || isExternalActionResultWithinResponseEnvelopeLimitV1(response)) return response;
    if (!params.lifecycle) return { success: false, errorCode: 'unsupported', error: 'Prepared file delivery is unavailable' };
    const prepared = await prepareScmFileBytesExport({ bytes: Buffer.from(response.contentBase64, 'base64'),
        name: params.request.path.split(/[\\/]/).at(-1) || 'content', lifecycle: params.lifecycle, signal: params.signal });
    return { success: true, sizeBytes: response.sizeBytes, sha256: response.sha256, prepared };
}
