import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { openLocalUploadSourceReader, resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import { uploadDaemonSessionAttachmentFromReader } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import {
    isTransferFinalizeRecoveryFailure,
    type TransferFinalizeRecoveryFailure,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import type { SessionAttachmentsUploadFinalizeResponse, SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';

export type AttachmentsUploadLocation = 'workspace' | 'os_temp';
export type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentsUploadConfig = Readonly<{
    uploadLocation: AttachmentsUploadLocation;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: VcsIgnoreStrategy;
    vcsIgnoreWritesEnabled: boolean;
    maxFileBytes: number;
}>;

export type AttachmentsUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export type SessionAttachmentsUploadFileResult =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; attachmentHandle?: SessionAttachmentHandleV1 }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
    | TransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>;

function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

function resolveUploadPreflightSizeTimeoutMs(): number {
    const raw = parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS);
    const fallback = 2_000;
    const resolved = raw ?? fallback;
    return Math.min(20_000, Math.max(100, resolved));
}

function describeUploadSource(source: AttachmentsUploadFileSource): Readonly<{
    name: string;
    sizeBytes: number;
    mimeType?: string;
}> {
    if (source.kind === 'web') {
        return {
            name: source.file.name,
            sizeBytes: source.file.size,
            mimeType: source.file.type || undefined,
        };
    }
    if (source.kind === 'memory') {
        return {
            name: source.name,
            sizeBytes: source.bytes.byteLength,
            mimeType: source.mimeType ? String(source.mimeType) : undefined,
        };
    }

    return {
        name: source.name,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : -1,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
    };
}

async function resolveSizeBytesWithTimeout(source: AttachmentsUploadFileSource): Promise<
    | Readonly<{ ok: true; value: number | null }>
    | Readonly<{ ok: false; error: string }>
> {
    const timeoutMs = resolveUploadPreflightSizeTimeoutMs();
    return await new Promise((resolve) => {
        const timeoutId = setTimeout(
            () => resolve({ ok: false, error: 'Upload preflight size resolution timed out' } as const),
            timeoutMs,
        );

        resolveLocalUploadSourceSizeBytes(source).then(
            (value) => {
                clearTimeout(timeoutId);
                resolve({ ok: true, value } as const);
            },
            (error) => {
                clearTimeout(timeoutId);
                resolve({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Upload preflight failed to resolve file size',
                } as const);
            },
        );
    });
}

export async function sessionAttachmentsUploadFile(args: Readonly<{
    sessionId: string;
    sessionTarget?: ExactSessionMachineTargetIdentity;
    transferContext?: SessionAttachmentTransferContext;
    file: AttachmentsUploadFileSource;
    messageLocalId: string;
    config: AttachmentsUploadConfig;
    onProgress?: (progress: AttachmentsUploadProgress) => void;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<SessionAttachmentsUploadFileResult> {
    const isCurrent = () => !args.signal?.aborted && (args.isCurrent?.() ?? true);
    const assertCurrent = () => {
        if (!isCurrent()) throw new Error('Upload canceled');
    };
    try {
        assertCurrent();
        let described = describeUploadSource(args.file);
        if (described.sizeBytes < 0) {
            const resolved = await resolveSizeBytesWithTimeout(args.file);
            assertCurrent();
            if (!resolved.ok) {
                return { success: false, error: resolved.error };
            }
            if (resolved.value != null) {
                described = { ...described, sizeBytes: resolved.value };
            }
        }

        if (described.sizeBytes < 0) {
            return { success: false, error: 'Unknown attachment size' };
        }
        if (described.sizeBytes > args.config.maxFileBytes) {
            return { success: false, error: 'File exceeds maximum allowed size' };
        }

        const reader = await openLocalUploadSourceReader(args.file);
        let readerClosed = false;
        const closeReaderOnce = async () => {
            if (readerClosed) {
                return;
            }
            readerClosed = true;
            await reader.close();
        };
        try {
            assertCurrent();
            const transferContext = args.transferContext
                ?? (await import('@/sync/sync')).sync.getSessionAttachmentTransferContext(args.sessionId,
                    args.sessionTarget ? { purpose: 'attachmentUpload', target: args.sessionTarget } : undefined);
            assertCurrent();
            if (args.sessionTarget && !transferContext) {
                return { success: false, error: 'Session attachment scope is unavailable' };
            }
            const bulkUpload = await uploadDaemonSessionAttachmentFromReader({
                session: args.sessionTarget ?? args.sessionId,
                transferContext,
                fileReader: {
                    sizeBytes: described.sizeBytes,
                    readBytes: async (offset, length) => {
                        assertCurrent();
                        const bytes = await reader.readBytes(offset, length);
                        assertCurrent();
                        return bytes;
                    },
                    close: async () => await closeReaderOnce(),
                },
                request: {
                    messageLocalId: args.messageLocalId,
                    fileName: described.name,
                    sizeBytes: described.sizeBytes,
                    uploadLocation: args.config.uploadLocation,
                    workspaceRelativeDir: args.config.workspaceRelativeDir,
                    vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
                    vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
                },
                onProgress: args.onProgress
                    ? (progress) => {
                        if (!isCurrent()) return;
                        try {
                            args.onProgress?.(progress);
                        } catch {
                            // ignore
                        }
                    }
                    : null,
                ...(args.signal ? { signal: args.signal } : {}),
            });
            assertCurrent();

            if (bulkUpload.success !== true) {
                if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(bulkUpload)) {
                    return bulkUpload;
                }
                return { success: false, error: bulkUpload.error ?? 'Upload failed', errorCode: bulkUpload.errorCode };
            }

            return { success: true, path: bulkUpload.path, sizeBytes: bulkUpload.sizeBytes, sha256: bulkUpload.sha256,
                ...(bulkUpload.attachmentHandle ? { attachmentHandle: bulkUpload.attachmentHandle } : {}) };
        } finally {
            try {
                await closeReaderOnce();
            } catch {
                // ignore
            }
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
