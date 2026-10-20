import type { ComposerAttachmentDraftV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1, type ComposerContentHandleV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';

import { decodeBase64 } from '@/encryption/base64';
import {
    captureComposerContentSubmission,
    claimComposerContent,
    inspectComposerContent,
    releaseComposerContent,
    uploadComposerMediaStageFromReader,
    type ComposerMediaStageUploadResult,
} from '@/sync/domains/transfers/runtime/transferRuntime/families/composerMediaStageTransfers';
import type { TransferFileReader } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';

export async function prepareTargetComposerAttachments(input: Readonly<{
    attachments: readonly ComposerAttachmentDraftV1[];
    sourceComposerRef: ComposerRefV1;
    targetComposerRef: Extract<ComposerRefV1, { kind: 'session' }>;
    executionTarget: SessionExecutionTargetV1;
    messageLocalId: string;
    signal?: AbortSignal | null;
    isCurrent?: () => boolean;
}>): Promise<Readonly<{
    attachments: readonly ComposerAttachmentDraftV1[];
    releaseOnRejection: () => Promise<void>;
}> | null> {
    const isCurrent = () => !input.signal?.aborted && (input.isCurrent?.() ?? true);
    if (!isCurrent()) return null;
    const acquired: Array<Readonly<{
        handle: ComposerContentHandleV1;
        attachmentInstanceId: string;
        claimed: boolean;
    }>> = [];
    const releaseStage = async (stage: (typeof acquired)[number]) => {
        // Cleanup outlives caller cancellation and must never release
        // the captured source or its original draft claim.
        const result = await releaseComposerContent(stage.handle, { ...(stage.claimed ? { claimant: {
            composer: input.targetComposerRef,
            attachmentInstanceId: stage.attachmentInstanceId,
        } } : {}), observerSignal: input.signal });
        if (!result.success) throw new Error(result.error);
        const index = acquired.indexOf(stage);
        if (index >= 0) acquired.splice(index, 1);
    };
    const releaseOnRejection = async () => {
        let failure: Error | null = null;
        for (const stage of [...acquired]) {
            try {
                await releaseStage(stage);
            } catch (error) {
                failure ??= error instanceof Error ? error : new Error('Composer media cleanup unavailable');
            }
        }
        if (failure) throw failure;
    };
    const attachments: ComposerAttachmentDraftV1[] = [];
    try {
        for (const attachment of input.attachments) {
            if (!isCurrent()) throw new Error('Composer submission is no longer current');
            if (!attachment.content) {
                attachments.push(attachment);
                continue;
            }
            const source = attachment.content.handle;
            let handle: ComposerContentHandleV1;
            if (source.executionTarget.serverId === input.executionTarget.serverId
                && source.executionTarget.machineId === input.executionTarget.machineId) {
                const captured = await captureComposerContentSubmission(source, {
                    sourceComposerRef: input.sourceComposerRef,
                    destinationComposerRef: input.targetComposerRef,
                    attachmentInstanceId: attachment.instanceId,
                    messageLocalId: input.messageLocalId,
                }, { signal: input.signal });
                if (captured.status !== 'claimed') throw new Error('Composer media target custody unavailable');
                handle = captured.handle;
                if (captured.newlyAcquired) acquired.push({ handle, attachmentInstanceId: attachment.instanceId, claimed: true });
            } else {
                let closed = false;
                const reader: TransferFileReader = {
                    sizeBytes: source.sizeBytes,
                    readBytes: async (offset, length) => {
                        if (closed || !isCurrent()) throw new Error('Composer submission is no longer current');
                        const bytes = new Uint8Array(length);
                        for (let read = 0; read < length;) {
                            if (!isCurrent()) throw new Error('Composer submission is no longer current');
                            const maxBytes = Math.min(length - read, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1);
                            const inspected = await inspectComposerContent(source, { offset: offset + read, maxBytes }, {
                                signal: input.signal,
                                ...('sessionId' in input.sourceComposerRef ? { sessionId: input.sourceComposerRef.sessionId } : {}),
                            });
                            if (!inspected.success || !isCurrent()) throw new Error('Composer media source unavailable');
                            const chunk = decodeBase64(inspected.result.bytesBase64, 'base64');
                            if (inspected.result.offset !== offset + read || chunk.byteLength !== maxBytes) {
                                throw new Error('Composer media source returned an invalid range');
                            }
                            bytes.set(chunk, read);
                            read += chunk.byteLength;
                        }
                        return bytes;
                    },
                    close: async () => { closed = true; },
                };
                let uploaded = await uploadComposerMediaStageFromReader({
                    fileReader: reader,
                    executionTarget: input.executionTarget,
                    owner: source.owner,
                    mediaKind: source.mediaKind,
                    mimeType: source.mimeType,
                    name: source.name,
                    sha256: source.sha256,
                    signal: input.signal,
                });
                if (isTransferFinalizeRecoveryFailure<ComposerMediaStageUploadResult>(uploaded)) {
                    const recovered = await runTransferFinalizeRecovery({
                        recovery: uploaded.recovery,
                        signal: input.signal,
                        title: t('transferRecovery.title'),
                        message: t('transferRecovery.message'),
                    });
                    // An unavailable/dismissed presentation refuses preparation
                    // before any Message is issued, as in the media picker.
                    if (recovered?.status !== 'finalized') throw new Error('Composer media finalization unavailable');
                    uploaded = recovered.response;
                }
                if (!uploaded.success) {
                    throw new Error('Composer media target upload unavailable');
                }
                handle = uploaded.handle;
                const stage = { handle, attachmentInstanceId: attachment.instanceId, claimed: false };
                acquired.push(stage);
                if (!isCurrent()) throw new Error('Composer submission is no longer current');
                const claim = await claimComposerContent(handle, {
                    composer: input.targetComposerRef,
                    attachmentInstanceId: attachment.instanceId,
                }, { signal: input.signal });
                if (claim.status !== 'claimed') throw new Error('Composer media target custody unavailable');
                stage.claimed = true;
                if (!isCurrent()) throw new Error('Composer submission is no longer current');
                const captured = await captureComposerContentSubmission(handle, {
                    sourceComposerRef: input.targetComposerRef,
                    destinationComposerRef: input.targetComposerRef,
                    attachmentInstanceId: attachment.instanceId,
                    messageLocalId: input.messageLocalId,
                }, { signal: input.signal });
                if (captured.status !== 'claimed') throw new Error('Composer media target snapshot unavailable');
                handle = captured.handle;
                // A deterministic rejoin may still back an already accepted
                // Pending input. Only this invocation's new fork is disposable.
                if (captured.newlyAcquired) acquired.push({ handle, attachmentInstanceId: attachment.instanceId, claimed: true });
                await releaseStage(stage);
            }
            if (!isCurrent()) throw new Error('Composer submission is no longer current');
            attachments.push({ ...attachment, content: { kind: 'stagedMedia', handle } });
        }
        return { attachments, releaseOnRejection };
    } catch {
        try { await releaseOnRejection(); } catch (error) {
            if (!input.signal?.aborted) throw error;
        }
        return null;
    }
}
