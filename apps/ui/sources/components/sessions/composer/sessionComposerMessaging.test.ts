import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ActionApprovalRequestCreatedResultSchema,
    ActionExecuteFailureSchema,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import { withSessionTargetFanoutResultV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { MENTION_KIND_V1, buildMentionRefForKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ComposerContentHandleV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const rpc = vi.hoisted(() => vi.fn());
// The guarded Machine RPC is the physical network boundary; transfer parsing and custody stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => rpc(...args),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

import type { ComposerSubmissionSnapshot } from './composerSubmissionCoordinator';
const messaging = await import('./sessionComposerMessaging');
const { readSessionComposerMessageIntent, readSessionComposerMessagingHandoff, readSessionComposerMessagingOutcome } = messaging;

afterEach(async () => { rpc.mockReset(); await homes.reset(); });

const sendOutputSchema = withSessionTargetFanoutResultV1(SessionMessageSendResultV1Schema);

function admitted(status: 'accepted' | 'alreadyAccepted', localId: string): ActionExecuteResult {
    return { ok: true, result: SessionMessageSendResultV1Schema.parse({ status, localId }) };
}

function fanout(results: readonly ActionExecuteResult[]): ActionExecuteResult {
    return { ok: true, result: sendOutputSchema.parse({ kind: 'fanout', results: results.map((result, index) => ({
        target: { serverId: 'home', sessionId: `worker-${index}` }, result,
    })) }) };
}

function snapshot(text: string, referenceStart: number | null): ComposerSubmissionSnapshot {
    const token = '@Reviewer';
    return ComposerSnapshotV1Schema.parse({
        ref: { kind: 'session', sessionId: 'source' }, revision: 1, text,
        references: referenceStart === null ? [] : [{
            kind: MENTION_KIND_V1.session,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'reviewer-session'),
            token, start: referenceStart, end: referenceStart + token.length, label: 'Reviewer',
        }],
        attachments: [], layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    });
}

describe('Session composer messaging handoff', () => {
    it('distinguishes a partial target handoff from a fully admitted fanout', () => {
        const accepted = admitted('accepted', 'request-a');
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_unavailable', error: 'Target unavailable' });
        expect(readSessionComposerMessagingHandoff(fanout([accepted, failure]))).toBe('partial');
        expect(readSessionComposerMessagingHandoff(fanout([accepted, admitted('alreadyAccepted', 'request-b')]))).toBe('accepted');
    });

    it('tells the person how many targets took a partial send, from the frozen fanout itself', () => {
        const accepted = admitted('accepted', 'request-a');
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_unavailable', error: 'Target unavailable' });
        expect(readSessionComposerMessagingOutcome(fanout([accepted, failure, failure]))).toEqual({ kind: 'partial', accepted: 1, total: 3 });
        expect(readSessionComposerMessagingOutcome(failure)).toEqual({ kind: 'unaccepted', error: 'Target unavailable' });
        expect(readSessionComposerMessagingOutcome(fanout([accepted]))).toEqual({ kind: 'accepted' });
    });

    it('keeps rejected or uncertain input unaccepted, including an unresolved member of a fanout', () => {
        const uncertain: ActionExecuteResult = { ok: true, result: SessionMessageSendResultV1Schema.parse({
            status: 'outcomeUnknown', localId: 'request-b', code: 'session_input_admission_identity_mismatch',
        }) };
        const rejected: ActionExecuteResult = { ok: true, result: SessionMessageSendResultV1Schema.parse({
            status: 'rejected', code: 'session_input_target_unavailable',
        }) };
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'session_target_empty', error: 'No targets' });
        expect(readSessionComposerMessagingHandoff(uncertain)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(rejected)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(failure)).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(fanout([uncertain, rejected, failure]))).toBe('unaccepted');
        expect(readSessionComposerMessagingHandoff(fanout([admitted('accepted', 'request-a'), uncertain]))).toBe('partial');
    });

    it('keeps an approval request pending rather than clearing the composer as admitted', () => {
        const approval = ActionApprovalRequestCreatedResultSchema.parse({
            kind: 'approval_request_created', artifactId: 'approval', actionId: 'session.message.send',
        });
        expect(readSessionComposerMessagingHandoff({ ok: true, result: approval })).toBe('approval_pending');
    });

    it('recognizes durable held input and an admitted terminal result without treating the result as unaccepted', () => {
        const held = SessionMessageSendResultV1Schema.parse({ status: 'held', localId: 'request-a', code: 'autonomous_check_in' });
        const replied = SessionMessageSendResultV1Schema.parse({ status: 'replied', localId: 'request-b', outcome: { kind: 'pass' } });
        expect(readSessionComposerMessagingHandoff(fanout([{ ok: true, result: held }, { ok: true, result: replied }]))).toBe('accepted');
    });
});

describe('Session composer structured addressing', () => {
    it('turns a selected leading Session reference into an Ask for its actual Session identity', () => {
        expect(readSessionComposerMessageIntent(snapshot('  @Reviewer inspect this change', 2))).toEqual({
            kind: 'ask', target: 'reviewer-session',
        });
    });

    it.each([
        ['unselected text', '@Reviewer inspect this change', null],
        ['contextual reference', 'I asked @Reviewer about this change', 8],
        ['quoted reference', '"@Reviewer inspect this change"', 1],
        ['quoted block', '> @Reviewer inspect this change', 2],
        ['stale selected reference', '@SomeoneElse inspect this change', 0],
    ] as const)('keeps %s inert', (_case, text, referenceStart) => {
        expect(readSessionComposerMessageIntent(snapshot(text, referenceStart))).toBeNull();
    });

    it('preserves an explicit recipient choice over a leading reference', () => {
        const explicit = { kind: 'send', target: { selector: 'workers' } } as const;
        expect(readSessionComposerMessageIntent(snapshot('@Reviewer inspect this change', 0), explicit)).toEqual(explicit);
    });
});

describe('Session composer invocation attachment capture', () => {
    const sourceComposerRef = { kind: 'session', sessionId: 'source-session' } as const;
    const handle = ComposerContentHandleV1Schema.parse({ v: 1, id: 'original-stage',
        executionTarget: { serverId: 'home-a', machineId: 'machine-a' },
        owner: { pluginId: 'com.example.media', localId: 'image' }, mediaKind: 'image',
        mimeType: 'image/png', name: 'picture.png', sizeBytes: 4, sha256: 'a'.repeat(64) });
    const attachment = ComposerAttachmentDraftV1Schema.parse({ v: 1, instanceId: 'attachment-a',
        attachment: handle.owner, key: 'photo', value: { caption: 'keep' },
        presentation: { label: 'Picture', typeLabel: 'Image' }, content: { kind: 'stagedMedia', handle } });
    const { content: _content, ...contentless } = attachment;
    const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1,
        composerAttachments: [contentless, attachment] });
    const fork = { ...handle, id: 'invocation-snapshot' };
    const input = { structuredInput, sourceComposerRef, messageLocalId: 'message-a', isCurrent: () => true };
    const releasedIds = () => rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)
        .map(([call]) => call.payload.handle.id);

    it.each([true, false])('captures exact staged fields while preserving originals and cleanup ownership (newlyAcquired:%s)', async newlyAcquired => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired, handle: fork });
        const captured = await messaging.captureSessionComposerMessageAttachments(input);
        expect(captured?.structuredInput).toEqual({ ...structuredInput,
            composerAttachments: [contentless, { ...attachment, content: { kind: 'stagedMedia', handle: fork } }] });
        expect(structuredInput.composerAttachments?.[1]?.content?.handle).toEqual(handle);
        expect(rpc.mock.calls[0]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM,
            payload: { handle, claimant: { composer: sourceComposerRef, attachmentInstanceId: attachment.instanceId },
                submission: { destinationComposerRef: sourceComposerRef, messageLocalId: 'message-a' } } });
        rpc.mockResolvedValue({ success: true });
        await captured?.releaseSnapshots();
        await captured?.releaseSnapshots();
        expect(releasedIds()).toEqual(newlyAcquired ? [fork.id] : []);
        if (newlyAcquired) expect(rpc.mock.calls.at(-1)?.[0].payload.claimant).toEqual({
            composer: sourceComposerRef, attachmentInstanceId: attachment.instanceId });
    });

    it.each(['failed', 'stale', 'cancelled'] as const)('releases captured snapshots only when a later capture is %s', async outcome => {
        let current = true;
        const cancellation = new AbortController();
        rpc.mockImplementation(async (call: { method: string; payload: { handle: { id: string } } }) => {
            if (call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) return { success: true };
            if (call.payload.handle.id === handle.id) return { success: true, newlyAcquired: true, handle: fork };
            if (outcome === 'stale') current = false;
            if (outcome === 'cancelled') cancellation.abort();
            return outcome === 'failed' ? { success: false, error: 'Unavailable' }
                : { success: true, newlyAcquired: true, handle: { ...handle, id: 'second-snapshot' } };
        });
        const second = { ...attachment, instanceId: 'attachment-b', content: { kind: 'stagedMedia' as const,
            handle: { ...handle, id: 'second-original' } } };
        await expect(messaging.captureSessionComposerMessageAttachments({ ...input,
            structuredInput: { v: 1, composerAttachments: [attachment, second] },
            signal: cancellation.signal, isCurrent: () => current })).resolves.toBeNull();
        expect(releasedIds()).toEqual(outcome === 'failed' ? [fork.id] : [fork.id, 'second-snapshot']);
    });

    it('does not capture when stale or cancelled and leaves contentless input untouched', async () => {
        const cancelled = new AbortController(); cancelled.abort();
        expect(await messaging.captureSessionComposerMessageAttachments({ ...input, signal: cancelled.signal })).toBeNull();
        expect(await messaging.captureSessionComposerMessageAttachments({ ...input, isCurrent: () => false })).toBeNull();
        const empty = { v: 1 as const, composerAttachments: [contentless] };
        expect((await messaging.captureSessionComposerMessageAttachments({ ...input, structuredInput: empty }))?.structuredInput).toBe(empty);
        expect((await messaging.captureSessionComposerMessageAttachments({ ...input, structuredInput: undefined }))?.structuredInput).toBeUndefined();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('observes cleanup failure and permits a retry without releasing the original', async () => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: fork });
        const captured = await messaging.captureSessionComposerMessageAttachments(input);
        rpc.mockResolvedValueOnce({ success: false, error: 'Machine unavailable' });
        await expect(captured?.releaseSnapshots()).rejects.toThrow('Machine unavailable');
        rpc.mockResolvedValueOnce({ success: true });
        await expect(captured?.releaseSnapshots()).resolves.toBeUndefined();
        expect(releasedIds()).toEqual([fork.id, fork.id]);
    });

    it('settles a cancelled snapshot cleanup observer while exact-Home cleanup remains live for a late answer', async () => {
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: fork });
        const cancellation = new AbortController();
        const captured = await messaging.captureSessionComposerMessageAttachments({ ...input, signal: cancellation.signal });
        let finish!: (result: { success: true }) => void;
        let cleanupSignal: AbortSignal | undefined;
        rpc.mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
            cleanupSignal = call.signal;
            return await new Promise(resolve => { finish = resolve; });
        });
        const cleanup = captured!.releaseSnapshots();
        const observed = cleanup.then(() => ({ status: 'released' }), error => ({ status: 'failed', error }));
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        cancellation.abort();
        let settled = false;
        void observed.then(() => { settled = true; });
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(observed).resolves.toMatchObject({ status: 'failed', error: { name: 'AbortError' } });
        expect(cleanupSignal?.aborted).toBe(false);
        finish({ success: true });
        await Promise.resolve();
        rpc.mockResolvedValueOnce({ success: true, newlyAcquired: true, handle: { ...fork, id: 'next-snapshot' } });
        const next = await messaging.captureSessionComposerMessageAttachments({ ...input, signal: new AbortController().signal });
        rpc.mockResolvedValueOnce({ success: true });
        await expect(next?.releaseSnapshots()).resolves.toBeUndefined();
        expect(releasedIds()).toEqual([fork.id, 'next-snapshot']);
    });
});
