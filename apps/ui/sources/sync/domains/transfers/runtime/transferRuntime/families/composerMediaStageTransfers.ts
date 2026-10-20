import { COMPOSER_MEDIA_CONTENT_CAPABILITY_V1, ComposerContentHandleV1Schema, ComposerContentClaimRequestV1Schema, ComposerContentClaimResponseV1Schema, ComposerContentInspectRequestV1Schema, ComposerContentInspectWireResultV1Schema, type ComposerContentClaimRequestV1, type ComposerContentHandleV1, type ComposerContentInspectRequestV1, type ComposerContentInspectWireResultV1, type ComposerContentMediaKindV1, type ComposerContentMimeTypeV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { ComposerInstanceIdSchema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ComposerRefV1Schema, type ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ComposerContentClaimResponseV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { TransferFileReader } from './sessionAttachmentTransfers';
import { createWorkspaceFileTransferRpcCaller } from './workspaceFileTransferRpcCaller';
import {
    type ComposerMediaStageUploadRequest,
    type DirectTransferImportFinalizeResponse,
} from '../plumbing/directTransferImportClient';
import type { TransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';
import { uploadBulkPayloadFromFileViaMachineCarrier } from '../plumbing/uploadBulkPayloadFromFileViaMachineCarrier';
import { createBufferedTransferDestination } from '../carriers/createBufferedTransferDestination';
import { downloadBulkPayloadViaDirectExportToDestination } from '../plumbing/directTransferExportDownload';
import { resolveMachineCarrierRoute } from '../plumbing/machineCarrierHttpLease';
import { runWithHomeCredentialRequestSignal } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { observeTransferOperation } from '../plumbing/observeTransferOperation';

type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
export type ComposerMediaStageUploadResult = Readonly<{
    success: true;
    handle: ComposerContentHandleV1;
}>;

type ComposerMediaStageReleaseResponse = Readonly<{ success: true }> | TransferFailureResponse;
type ComposerMediaStageCapabilityResponse =
    | Readonly<{
        success: true;
        available: true;
        capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
    }>
    | TransferFailureResponse;

export type ComposerMediaContentAvailability =
    | Readonly<{
        available: true;
        capability: typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
    }>
    | Readonly<{ available: false }>;

export type ComposerContentTransferResult<T> =
    | Readonly<{ success: true; result: T }>
    | TransferFailureResponse;

function transferFailure(error: string, errorCode?: string): TransferFailureResponse {
    return {
        success: false,
        error,
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
    };
}

/**
 * Negotiates the exact current-daemon media operation before a picker opens.
 * Missing or malformed older-daemon responses fail closed without creating a
 * UI capability cache or a second transfer authority.
 */
export async function getComposerMediaContentAvailability(params: Readonly<{
    executionTarget: SessionExecutionTargetV1;
    signal?: AbortSignal | null;
}>): Promise<ComposerMediaContentAvailability> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.executionTarget.machineId,
        serverId: params.executionTarget.serverId,
    });
    const response = await transferClient.call<ComposerMediaStageCapabilityResponse, Readonly<Record<string, never>>>({
        machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
        request: {},
        signal: params.signal ?? null,
    });
    return response.success === true
        && response.available === true
        && response.capability === COMPOSER_MEDIA_CONTENT_CAPABILITY_V1
        ? { available: true, capability: COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 }
        : { available: false };
}

function resolveInspectionRange(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1): number {
    return Math.min(request.maxBytes, Math.max(0, handle.sizeBytes - request.offset));
}

function parseComposerMediaStageHandle(input: Readonly<{
    value: unknown;
    request: Pick<ComposerContentHandleV1, 'executionTarget' | 'owner' | 'mediaKind' | 'mimeType' | 'sizeBytes' | 'sha256'>;
}>): ComposerContentHandleV1 | null {
    const parsed = ComposerContentHandleV1Schema.safeParse(input.value);
    if (!parsed.success) return null;
    const handle = parsed.data;
    if (
        handle.executionTarget.serverId !== input.request.executionTarget.serverId
        || handle.executionTarget.machineId !== input.request.executionTarget.machineId
        || handle.owner.pluginId !== input.request.owner.pluginId
        || handle.owner.localId !== input.request.owner.localId
        || handle.mediaKind !== input.request.mediaKind
        || handle.mimeType !== input.request.mimeType
        || handle.sizeBytes !== input.request.sizeBytes
        || handle.sha256.toLowerCase() !== input.request.sha256.toLowerCase()
    ) {
        return null;
    }
    return handle;
}

function parseComposerMediaStageFinalizeResponse(input: Readonly<{
    response: Pick<Extract<DirectTransferImportFinalizeResponse, { success: true }>, 'finalized'>;
    request: ComposerMediaStageUploadRequest;
}>): ComposerMediaStageUploadResult | null {
    const handle = parseComposerMediaStageHandle({
        value: input.response.finalized.result,
        request: input.request,
    });
    return handle ? { success: true, handle } : null;
}

export async function uploadComposerMediaStageFromReader(params: Readonly<{
    fileReader: TransferFileReader;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ComposerContentMimeTypeV1;
    name: string;
    sha256: string;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    | ComposerMediaStageUploadResult
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<ComposerMediaStageUploadResult>
> {
    const request: ComposerMediaStageUploadRequest = {
        t: 'composer_media_stage_upload_v1',
        executionTarget: params.executionTarget,
        owner: params.owner,
        mediaKind: params.mediaKind,
        mimeType: params.mimeType,
        name: params.name,
        sizeBytes: params.fileReader.sizeBytes,
        sha256: params.sha256.trim().toLowerCase(),
    };
    return await uploadBulkPayloadFromFileViaMachineCarrier<ComposerMediaStageUploadResult>({
        machineId: request.executionTarget.machineId,
        serverId: request.executionTarget.serverId,
        fileReader: params.fileReader,
        directImportRequest: {
            ...request,
            workingDirectory: '/',
        },
        parseDirectFinalizeResponse: (response) => parseComposerMediaStageFinalizeResponse({
            response,
            request,
        }),
        signal: params.signal ?? null,
        onProgress: params.onProgress ?? null,
    });
}

/**
 * Reads a bounded opaque stage range through the incumbent encrypted download
 * carrier. The UI retains no stage path, bytes cache, or transfer identity.
 */
export async function inspectComposerContent(
    rawHandle: ComposerContentHandleV1,
    rawRequest: ComposerContentInspectRequestV1,
    options?: Readonly<{ signal?: AbortSignal | null; sessionId?: string }>,
): Promise<ComposerContentTransferResult<ComposerContentInspectWireResultV1>> {
    const handle = ComposerContentHandleV1Schema.safeParse(rawHandle);
    const request = ComposerContentInspectRequestV1Schema.safeParse(rawRequest);
    if (!handle.success || !request.success) return transferFailure('Invalid Composer media inspection request');

    const expectedSizeBytes = resolveInspectionRange(handle.data, request.data);
    const buffered = createBufferedTransferDestination(request.data.maxBytes);
    const directExportRequest = {
        t: 'composer_media_stage_inspect_v1',
        ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        handle: handle.data,
        offset: request.data.offset,
        maxBytes: request.data.maxBytes,
    } as const;

    if (options?.signal?.aborted) {
        buffered.reset();
        return transferFailure('Composer media inspection canceled');
    }
    const machineRoute = await resolveMachineCarrierRoute(
        handle.data.executionTarget.machineId,
        handle.data.executionTarget.serverId,
    );
    if (machineRoute.kind !== 'iroh_peer') {
        buffered.reset();
        return machineRoute.kind === 'unavailable'
            ? transferFailure(machineRoute.error, machineRoute.errorCode)
            : transferFailure('This transfer requires a newer machine runtime');
    }

    const direct = await downloadBulkPayloadViaDirectExportToDestination({
        machineId: handle.data.executionTarget.machineId,
        serverId: handle.data.executionTarget.serverId,
        request: directExportRequest,
        destination: buffered.destination,
        onInit: async (init) => (
            init.name === handle.data.name && init.sizeBytes === expectedSizeBytes
                ? undefined
                : transferFailure('Composer media inspection returned an invalid range')
        ),
        signal: options?.signal ?? null,
        acquirePreparedCarrier: async ({ operationId }) => await machineRoute.acquire({
            operationId,
            signal: options?.signal ?? undefined,
        }),
    });
    if (direct.ok) {
        const result = ComposerContentInspectWireResultV1Schema.safeParse({
            offset: request.data.offset,
            bytesBase64: buffered.toBase64(),
            eof: request.data.offset + direct.sizeBytes >= handle.data.sizeBytes,
        });
        return result.success
            ? { success: true, result: result.data }
            : transferFailure('Composer media inspection returned an invalid range');
    }
    buffered.reset();
    return transferFailure(direct.error, direct.errorCode);
}

export type ComposerContentClaimOutcome =
    | Readonly<{ status: 'claimed'; newlyAcquired: boolean }>
    | Readonly<{ status: 'claimedElsewhere' }>
    | Readonly<{ status: 'unavailable' }>;

export type ComposerContentSubmissionCaptureOutcome =
    | Readonly<{ status: 'claimed'; newlyAcquired: boolean; handle: ComposerContentHandleV1 }>
    | Exclude<ComposerContentClaimOutcome, Readonly<{ status: 'claimed' }>>;

/** Capture immutable source bytes at their existing custody owner before submission or transfer. */
export async function captureComposerContentSubmission(
    rawHandle: ComposerContentHandleV1,
    capture: Readonly<{
        sourceComposerRef: ComposerRefV1;
        destinationComposerRef: ComposerRefV1;
        attachmentInstanceId: string;
        messageLocalId: string;
    }>,
    options?: Readonly<{ signal?: AbortSignal | null }>,
): Promise<ComposerContentSubmissionCaptureOutcome> {
    const request = ComposerContentClaimRequestV1Schema.safeParse({
        handle: rawHandle,
        claimant: { composer: capture.sourceComposerRef, attachmentInstanceId: capture.attachmentInstanceId },
        submission: { destinationComposerRef: capture.destinationComposerRef, messageLocalId: capture.messageLocalId },
    });
    if (!request.success || options?.signal?.aborted) return { status: 'unavailable' };
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: request.data.handle.executionTarget.machineId,
        serverId: request.data.handle.executionTarget.serverId,
    });
    try {
        const response = ComposerContentClaimResponseV1Schema.safeParse(await transferClient.call<ComposerContentClaimResponseV1, ComposerContentClaimRequestV1>({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            request: request.data,
            signal: options?.signal ?? null,
        }));
        if (!response.success) return { status: 'unavailable' };
        if (!response.data.success) return response.data.claimedElsewhere === true
            ? { status: 'claimedElsewhere' } : { status: 'unavailable' };
        const handle = parseComposerMediaStageHandle({ value: response.data.handle, request: request.data.handle });
        if (!handle || handle.id === request.data.handle.id || handle.name !== request.data.handle.name) return { status: 'unavailable' };
        return { status: 'claimed', newlyAcquired: response.data.newlyAcquired, handle };
    } catch {
        return { status: 'unavailable' };
    }
}

/**
 * Claims completed staged media for one exact Composer attachment at the
 * transfer store, before the attachment can be published into a draft. The
 * store is the custody owner: a handle already claimed by another document or
 * attachment resolves `claimedElsewhere` and the caller must not publish.
 */
export async function claimComposerContent(
    rawHandle: ComposerContentHandleV1,
    claimant: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>,
    options?: Readonly<{ signal?: AbortSignal | null }>,
): Promise<ComposerContentClaimOutcome> {
    const request = ComposerContentClaimRequestV1Schema.safeParse({ handle: rawHandle, claimant });
    if (!request.success) return { status: 'unavailable' };
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: request.data.handle.executionTarget.machineId,
        serverId: request.data.handle.executionTarget.serverId,
    });
    try {
        const response = ComposerContentClaimResponseV1Schema.safeParse(await transferClient.call<ComposerContentClaimResponseV1, ComposerContentClaimRequestV1>({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            request: request.data,
            signal: options?.signal ?? null,
        }));
        if (!response.success) return { status: 'unavailable' };
        if (response.data.success) {
            return { status: 'claimed', newlyAcquired: response.data.newlyAcquired };
        }
        return response.data.claimedElsewhere === true
            ? { status: 'claimedElsewhere' }
            : { status: 'unavailable' };
    } catch {
        return { status: 'unavailable' };
    }
}

/** Idempotent completed-stage release for post-transaction draft cleanup. */
export async function releaseComposerContent(
    rawHandle: ComposerContentHandleV1,
    options?: Readonly<{
        signal?: AbortSignal | null;
        /** Stops waiting after a failed turn; the exact-Home cleanup still runs. */
        observerSignal?: AbortSignal | null;
        claimant?: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>;
    }>,
): Promise<Readonly<{ success: true }> | TransferFailureResponse> {
    const handle = ComposerContentHandleV1Schema.safeParse(rawHandle);
    if (!handle.success) return transferFailure('Invalid Composer media release request');
    const composer = options?.claimant
        ? ComposerRefV1Schema.safeParse(options.claimant.composer)
        : null;
    const attachmentInstanceId = options?.claimant
        ? ComposerInstanceIdSchema.safeParse(options.claimant.attachmentInstanceId)
        : null;
    if ((composer && !composer.success) || (attachmentInstanceId && !attachmentInstanceId.success)) {
        return transferFailure('Invalid Composer media release request');
    }
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: handle.data.executionTarget.machineId,
        serverId: handle.data.executionTarget.serverId,
    });
    const cleanup = runWithHomeCredentialRequestSignal(handle.data.executionTarget.serverId, async credentialSignal => {
        const cancellation = mergeAbortSignals([credentialSignal, options?.signal ?? undefined]);
        try {
            return await transferClient.call<ComposerMediaStageReleaseResponse, Readonly<{
                handle: ComposerContentHandleV1;
                claimant?: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>;
            }>>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
                request: {
                    handle: handle.data,
                    ...(composer?.success && attachmentInstanceId?.success
                        ? { claimant: { composer: composer.data, attachmentInstanceId: attachmentInstanceId.data } }
                        : {}),
                },
                signal: cancellation.signal,
            });
        } finally { cancellation.dispose(); }
    });
    return await observeTransferOperation(cleanup, options?.observerSignal);
}
