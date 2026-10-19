import { describe, expect, it, vi } from 'vitest';
import { buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, settleSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1, SessionFollowRuleSourceEvidenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { prepareSessionFollowHumanInputMetadata, observeSessionFollowHumanInputCommit } from './sessionFollowHumanInputOccurrence';
import { CommittedUserMessageSeqTracker } from '../../committedUserMessageSeqTracker';
import type { TranscriptLookupOutcome } from '../../transcriptMessageLookup';

const evidence = SessionFollowRuleSourceEvidenceV1Schema.parse({ v: 1, ownerAccountId: 'owner', event: { kind: 'person_wrote' },
    facts: { serverId: 'home', kind: 'session', startedBy: 'you', status: 'thinking', source: 'persisted' } });

describe('protected original human input Follow evidence', () => {
    function observeOriginal(change?: (original: Extract<TranscriptLookupOutcome, { type: 'found' }>['message']) => void, actorAccountId?: string) {
        const admission = buildTrustedHostSessionInputAdmissionV1('cli');
        const target = {
            homeId: 'home', accountId: 'owner', sessionId: 'source', machineId: 'machine', installationId: 'install',
        };
        const receipt = actorAccountId ? { v: 1 as const, issuer: 'authenticatedAccount' as const, actorAccountId,
            sessionRelationship: actorAccountId === 'owner' ? 'owner' as const : 'sharedEditor' as const, admittedTarget: target }
            : { v: 1 as const, issuer: 'authenticatedMachine' as const, admittedTarget: target };
        const original: Extract<TranscriptLookupOutcome, { type: 'found' }>['message'] = {
            id: 'message', localId: 'input', seq: 7, sidechainId: null, messageRole: 'user', createdAt: 1, updatedAt: 1,
            inputAdmissionReceipt: receipt, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Never forwarded' }, meta: {
                happierInputAuthorityV1: settleSessionInputRequestV1({ request: admission.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
                happierProvenanceV1: settleSessionMessageProvenanceV1({ request: admission.request, requestedProvenance: admission.provenance, inputAdmissionReceipt: receipt }),
                [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: { v: 1, ownerAccountId: 'owner', event: { kind: 'person_wrote' }, facts: {
                    serverId: 'home', kind: 'session', startedBy: 'you', status: 'thinking', source: 'persisted' } },
            } } },
        };
        change?.(original);
        const tracker = new CommittedUserMessageSeqTracker();
        const controller = new AbortController();
        const notifications: unknown[] = [];
        // Original transcript lookup and daemon notification are persistent-storage/transport boundaries.
        const readOriginal = vi.fn(async (): Promise<TranscriptLookupOutcome> => ({ type: 'found', message: original }));
        const onError = vi.fn();
        const observation = observeSessionFollowHumanInputCommit({ localId: 'input', sessionId: 'source', admission, evidence,
            tracker, signal: controller.signal, mode: 'plain', ctx: null, readOriginal,
            notify: async original => { notifications.push(original); }, onError });
        return { ...observation, tracker, controller, notifications, readOriginal, onError };
    }

    it('waits for actual commitment and verifies original custody before notifying once', async () => {
        const observing = observeOriginal();
        observing.settle(true);
        expect(observing.notifications).toEqual([]);
        expect(observing.readOriginal).not.toHaveBeenCalled();
        observing.tracker.record('other-input', 5);
        observing.tracker.record('input', 7);
        await vi.waitFor(() => expect(observing.notifications).toEqual([{ localId: 'input', seq: 7, evidence }]));
        observing.tracker.record('input', 7);
        expect(observing.readOriginal).toHaveBeenCalledTimes(1);
    });

    it('joins commitment observed before Pending acceptance without treating acceptance as a sequence', async () => {
        const observing = observeOriginal();
        observing.tracker.record('input', 7);
        expect(observing.readOriginal).not.toHaveBeenCalled();
        observing.settle(true);
        await vi.waitFor(() => expect(observing.notifications).toEqual([{ localId: 'input', seq: 7, evidence }]));
    });

    it.each(['owner', 'collaborator'])('keeps the authenticated %s author private for personal self-exclusion', async actor => {
        const observing = observeOriginal(undefined, actor);
        observing.settle(true);
        observing.tracker.record('input', 7);
        await vi.waitFor(() => expect(observing.notifications).toEqual([{ localId: 'input', seq: 7, evidence, authorAccountId: actor }]));
    });

    it.each(['missing_receipt', 'wrong_seq', 'sidechain', 'missing_authority', 'forged_provenance', 'stale_evidence'] as const)(
        'does not promote %s into a protected original human occurrence', async problem => {
            const observing = observeOriginal(original => {
                if (problem === 'missing_receipt') delete original.inputAdmissionReceipt;
                if (problem === 'wrong_seq') original.seq = 8;
                if (problem === 'sidechain') original.sidechainId = 'child';
                if (original.content.t !== 'plain') throw new Error('Expected plain fixture');
                const body = original.content.v as { meta: Record<string, unknown> };
                if (problem === 'missing_authority') delete body.meta.happierInputAuthorityV1;
                if (problem === 'forged_provenance') body.meta.happierProvenanceV1 = { v: 1, kind: 'host', producer: 'runtimeTranscript' };
                if (problem === 'stale_evidence') body.meta[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1] = { ...evidence, event: { kind: 'message' } };
            });
            observing.settle(true);
            observing.tracker.record('input', 7);
            await vi.waitFor(() => expect(observing.readOriginal).toHaveBeenCalledTimes(1));
            expect(observing.notifications).toEqual([]);
        });

    it.each(['rejected', 'aborted', 'disposed'] as const)('retires the request listener after %s', async reason => {
        const observing = observeOriginal();
        if (reason === 'rejected') observing.settle(false);
        if (reason === 'aborted') observing.controller.abort();
        if (reason === 'disposed') observing.dispose();
        observing.tracker.record('input', 7);
        observing.settle(true);
        expect(observing.readOriginal).not.toHaveBeenCalled();
        expect(observing.notifications).toEqual([]);
    });

    it('replaces authored evidence with only public-safe original source facts', () => {
        const meta = prepareSessionFollowHumanInputMetadata({ admission: buildTrustedHostSessionInputAdmissionV1('cli'), evidence,
            meta: { authored: 'kept', [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: { forged: true } } });
        expect(meta).toEqual({ authored: 'kept', [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: {
            v: 1, ownerAccountId: 'owner', event: { kind: 'person_wrote' }, facts: {
                serverId: 'home', kind: 'session', startedBy: 'you', status: 'thinking', source: 'persisted' } } });
    });

    it('strips authored occurrence authority from non-human and unavailable original facts', () => {
        for (const admission of [buildTrustedHostSessionInputAdmissionV1('agent'), buildTrustedHostSessionInputAdmissionV1('cli')]) {
            expect(prepareSessionFollowHumanInputMetadata({ admission, evidence: admission.request.producer === 'cli' ? null : evidence,
                meta: { authored: 'kept', [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: evidence } })).toEqual({ authored: 'kept' });
        }
    });

    it('requires original external-human plugin provenance and rejects forwarded, bot and host observations', () => {
        const request = { v: 1 as const, producer: 'pluginSession' as const,
            caller: { kind: 'plugin' as const, pluginId: 'acme.chat', contributionLocalId: 'incoming' }, permission: {} };
        const original = { v: 1 as const, kind: 'pluginSession' as const, pluginId: 'acme.chat', contributionLocalId: 'incoming',
            surface: 'background' as const, externalActor: { kind: 'human' as const }, contentProvenance: 'original' as const };
        expect(prepareSessionFollowHumanInputMetadata({ admission: { request, provenance: original }, evidence }))
            .toHaveProperty(SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1);
        for (const provenance of [{ ...original, contentProvenance: 'forwarded' as const },
            { ...original, externalActor: { kind: 'bot' as const } }, { v: 1 as const, kind: 'host' as const, producer: 'pluginSession' as const }]) {
            expect(prepareSessionFollowHumanInputMetadata({ admission: { request, provenance }, evidence,
                meta: { [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: evidence } })).toEqual({});
        }
    });
});
