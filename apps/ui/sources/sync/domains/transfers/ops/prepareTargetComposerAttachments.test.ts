import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ComposerContentHandleV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => rpc(...args),
}));
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({ getReadyServerFeatures: async () => null }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { prepareTargetComposerAttachments } from './prepareTargetComposerAttachments';

const executionTarget = { serverId: 'home-a', machineId: 'machine-a' };
const sourceComposerRef = { kind: 'session', sessionId: 'source-session' } as const;
const targetComposerRef = { kind: 'session', sessionId: 'target-session' } as const;
const handle = ComposerContentHandleV1Schema.parse({
    v: 1, id: 'source-snapshot', executionTarget,
    owner: { pluginId: 'com.example.media', localId: 'image' },
    mediaKind: 'image', mimeType: 'image/png', name: 'picture.png', sizeBytes: 4, sha256: 'a'.repeat(64),
});
const attachment = ComposerAttachmentDraftV1Schema.parse({
    v: 1, instanceId: 'attachment-a', attachment: handle.owner, key: 'photo', value: { caption: 'keep' },
    presentation: { label: 'Picture', typeLabel: 'Image' }, content: { kind: 'stagedMedia', handle },
});

describe('prepareTargetComposerAttachments', () => {
    beforeEach(() => { rpc.mockReset(); });

    it.each([true, false])('forks the frozen same-Machine source into the exact target Composer and releases only that fork on rejection (newlyAcquired:%s)', async newlyAcquired => {
        const targetHandle = { ...handle, id: 'target-snapshot' };
        rpc.mockImplementation(async (input: { method: string; payload: unknown }) => {
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM) {
                return { success: true, newlyAcquired, handle: targetHandle };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) return { success: true };
            throw new Error('Same-Machine custody must not start a byte transfer');
        });
        const prepared = await prepareTargetComposerAttachments({
            attachments: [attachment], sourceComposerRef, targetComposerRef, executionTarget, messageLocalId: 'message-a',
        });
        expect(prepared?.attachments).toEqual([{ ...attachment, content: { kind: 'stagedMedia', handle: targetHandle } }]);
        expect(rpc.mock.calls[0]?.[0]).toMatchObject({
            serverId: 'home-a', machineId: 'machine-a', method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            payload: {
                handle,
                claimant: { composer: sourceComposerRef, attachmentInstanceId: attachment.instanceId },
                submission: { destinationComposerRef: targetComposerRef, messageLocalId: 'message-a' },
            },
        });
        await prepared?.releaseOnRejection();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)
            .map(([call]) => call.payload)).toEqual(newlyAcquired ? [{
                handle: targetHandle, claimant: { composer: targetComposerRef, attachmentInstanceId: attachment.instanceId },
            }] : []);
    });

    it('does not stage contentless attachments or start work after cancellation', async () => {
        const { content: _content, ...contentless } = attachment;
        expect(await prepareTargetComposerAttachments({ attachments: [contentless], sourceComposerRef,
            targetComposerRef, executionTarget, messageLocalId: 'message-a' })).toMatchObject({ attachments: [contentless] });
        const canceled = new AbortController(); canceled.abort();
        expect(await prepareTargetComposerAttachments({ attachments: [attachment], sourceComposerRef,
            targetComposerRef, executionTarget, messageLocalId: 'message-a', signal: canceled.signal })).toBeNull();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('keeps failed target cleanup retryable and observable without touching the source', async () => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: { ...handle, id: 'target-snapshot' } });
        const prepared = await prepareTargetComposerAttachments({ attachments: [attachment], sourceComposerRef,
            targetComposerRef, executionTarget, messageLocalId: 'message-a' });
        rpc.mockResolvedValueOnce({ success: false, error: 'Machine unavailable' });
        await expect(prepared?.releaseOnRejection()).rejects.toThrow('Machine unavailable');
        rpc.mockResolvedValueOnce({ success: true });
        await expect(prepared?.releaseOnRejection()).resolves.toBeUndefined();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)
            .map(([call]) => call.payload.handle.id)).toEqual(['target-snapshot', 'target-snapshot']);
    });

    it('releases the target after cancellation without holding its rejected submission on an unanswered cleanup', async () => {
        const cancellation = new AbortController();
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: { ...handle, id: 'target-snapshot' } });
        const prepared = await prepareTargetComposerAttachments({ attachments: [attachment], sourceComposerRef,
            targetComposerRef, executionTarget, messageLocalId: 'message-a', signal: cancellation.signal });
        let complete!: () => void;
        rpc.mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
            expect(call.signal?.aborted).toBe(false);
            return await new Promise(resolve => { complete = () => resolve({ success: true }); });
        });
        cancellation.abort();
        await expect(prepared?.releaseOnRejection()).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
        complete();
    });
});
