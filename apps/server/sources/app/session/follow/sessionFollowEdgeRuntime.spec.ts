import { describe, expect, it, vi } from "vitest";
import {
    deriveSessionFollowWakeEventLocalIdV1,
    type SessionFollowAcknowledgeRequestV1,
} from "@happier-dev/protocol";
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import type { Tx } from "@/storage/inTx";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

import {
    acknowledgeSessionFollowFrontierInTx,
    observePendingSessionFollowForDestinationInTx,
} from "./sessionFollowEdgeService";

function runtimeFixture(policy: FollowPolicyV1 = { preset: 'quiet' }) {
    const row = (id: string, accountId: string) => ({
        id, accountId, account: { status: "active" }, archivedAt: null as Date | null, deliveryMutes: null,
        publisherGeneration: 3n, seq: 2, latestReadyEventSeq: 0, agentStateVersion: 0,
        latestTurnId: null, latestTurnStatus: null, publicShare: null as { expiresAt: Date | null } | null,
        currentStorageState: "hosted", acceptedThroughServerSeq: null,
        materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        shares: [] as { id: string; sharedWithUserId: string; accessLevel: string; canApprovePermissions: boolean }[],
        teamGrants: [], groupGrants: [],
    });
    const source = row("source", "source-owner");
    const destination = row("destination", "runtime");
    source.shares.push({ id: "source-read", sharedWithUserId: "runtime", accessLevel: "view", canApprovePermissions: false });
    const audience = [{ id: "runtime" }];
    const edge = {
        sourceSessionId: source.id, destinationSessionId: destination.id,
        relation: "follower" as "follower" | "manager",
        attachedAt: new Date(100),
        policyJson: JSON.stringify(policy),
        deliveredTranscriptSeq: 1, deliveredReadyEventSeq: 0, deliveredAgentStateVersion: 0,
        deliveredTurnId: null, deliveredTurnStatus: null,
    };
    let edgeExists = true;
    const wakeEventRows = new Map<string, Readonly<{
        seq: number;
        sidechainId: string | null;
        messageRole: string | null;
        transcriptObservationProvenance: unknown;
    }>>();
    const storage = {
        session: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                [source, destination].find(value => value.id === where.id) ?? null),
            findMany: vi.fn(async () => [source, destination]),
        },
        sessionMessage: {
            findUnique: vi.fn(async ({ where }: { where: { sessionId_localId: { sessionId: string; localId: string } } }) =>
                where.sessionId_localId.sessionId === destination.id && where.sessionId_localId.localId === "input-1"
                    ? { seq: 2, messageRole: "user" }
                    : where.sessionId_localId.sessionId === destination.id
                        ? wakeEventRows.get(where.sessionId_localId.localId) ?? null
                        : null),
        },
        account: {
            findUnique: vi.fn(async () => ({ status: "active" })),
            findMany: vi.fn(async () => audience),
        },
        sessionFollowEdge: {
            findMany: vi.fn(async () => edgeExists ? [edge] : []),
            findUnique: vi.fn(async () => edgeExists ? edge : null),
            updateMany: vi.fn(async ({ data }: { data: Partial<typeof edge> }) => {
                Object.assign(edge, data);
                return { count: 1 };
            }),
        },
    };
    // Database boundary only; the real access, audience, admission and frontier owners run below.
    const tx = storage as unknown as Tx;
    const expected = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    const principal = { kind: "destination_runtime", destinationRuntimeAccountId: "runtime", authentication } as const;
    const observeInput = { principal, destinationSessionId: destination.id };
    const ackInput = {
        principal, destinationSessionId: destination.id,
        sourceSessionId: source.id, expectedPublisherGeneration: 3n,
        policy,
        expected,
        observed: { ...expected, transcriptSeq: 2 },
        consumed: { ...expected, transcriptSeq: 2 },
        acceptance: { kind: "admitted_input", localInputId: "input-1", userMessageSeq: 2 } as const,
    };
    return {
        tx, storage, source, destination, audience, edge, observeInput, ackInput,
        commitWakeEvent: (eventLocalId: string, row: Readonly<{
            seq: number;
            sidechainId: string | null;
            messageRole: string | null;
            transcriptObservationProvenance: unknown;
        }> = {
            seq: 3,
            sidechainId: null,
            messageRole: "event",
            transcriptObservationProvenance: { kind: "non_dependent", source: "external" },
        }) => wakeEventRows.set(eventLocalId, row),
        removeEdge: () => { edgeExists = false; },
    };
}

describe("ordinary Account Follow runtime admission", () => {
    it("observes a manager through the same pairwise admission and fences reattachment at ACK", async () => {
        const f = runtimeFixture({ preset: 'important' });
        f.edge.relation = 'manager';
        const observed = await observePendingSessionFollowForDestinationInTx(f.tx, { ...f.observeInput, includeManager: true });
        expect(observed.observations).toEqual([expect.objectContaining({ relation: 'manager', attachedAt: 100 })]);
        f.edge.attachedAt = new Date(101);
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput, relation: 'manager', attachedAt: 100 }))
            .toEqual({ ok: false, rejection: 'stale_expected_frontier' });
        expect(f.storage.sessionFollowEdge.updateMany).not.toHaveBeenCalled();
        f.source.shares = [];
        expect(await observePendingSessionFollowForDestinationInTx(f.tx, { ...f.observeInput, includeManager: true }))
            .toEqual({ currentSourceSessionIds: [], observations: [] });
    });
    it("returns authoritative current membership even when no delivery delta is pending", async () => {
        const f = runtimeFixture();
        f.edge.deliveredTranscriptSeq = 2;

        expect(await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).toEqual({
            currentSourceSessionIds: ["source"],
            observations: [],
        });

        f.source.shares = [];
        expect(await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).toEqual({
            currentSourceSessionIds: [],
            observations: [],
        });
    });

    it("observes current content-free progress and accepts its exact frontier", async () => {
        const f = runtimeFixture();
        expect(await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).toEqual({
            currentSourceSessionIds: ["source"],
            observations: [{
                sourceSessionId: "source", destinationSessionId: "destination",
                policy: f.ackInput.policy,
                relation: "follower",
                delivered: f.ackInput.expected, observed: f.ackInput.consumed,
            }],
        });
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, f.ackInput)).toEqual({ ok: true, delivered: f.ackInput.consumed });
        expect(f.edge.deliveredTranscriptSeq).toBe(2);
    });

    it("requires ACK acceptance identity to name the exact admitted destination input", async () => {
        const f = runtimeFixture();
        const { acceptance: _acceptance, ...withoutAcceptance } = f.ackInput;
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, withoutAcceptance as never))
            .toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: { localInputId: "input-1", userMessageSeq: 2 } as never,
        })).toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: { kind: "admitted_input", localInputId: "unknown-input", userMessageSeq: 2 },
        })).toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: { kind: "admitted_input", localInputId: "input-1", userMessageSeq: 3 },
        })).toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: { kind: "admitted_input", localInputId: "input-1", userMessageSeq: 2 },
        })).toEqual({ ok: true, delivered: f.ackInput.consumed });
        expect(f.edge.deliveredTranscriptSeq).toBe(2);
    });

    it("accepts only a committed destination wake event for context-only provider evidence", async () => {
        const f = runtimeFixture();
        const observations = [{
            sourceSessionId: f.ackInput.sourceSessionId,
            policy: f.ackInput.policy,
            relation: 'follower' as const,
            expected: f.ackInput.expected,
            consumed: f.ackInput.consumed,
        }];
        let eventLocalId = deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId: f.ackInput.destinationSessionId,
            publisherGeneration: f.ackInput.expectedPublisherGeneration.toString(),
            observations,
        });
        f.commitWakeEvent(eventLocalId);
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput,
            acceptance: { kind: 'context_only_wake', eventLocalId, observations } }))
            .toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        const wakePolicy: FollowPolicyV1 = { preset: 'custom', events: { person_wrote: { delivery: 'interrupt' } } };
        f.edge.policyJson = JSON.stringify(wakePolicy);
        f.ackInput.policy = wakePolicy;
        observations[0].policy = wakePolicy;
        eventLocalId = deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId: f.ackInput.destinationSessionId,
            publisherGeneration: f.ackInput.expectedPublisherGeneration.toString(),
            observations,
        });
        const wakeAcceptance: SessionFollowAcknowledgeRequestV1["acceptance"] = {
            kind: "context_only_wake",
            eventLocalId,
            observations,
        };

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: { kind: "context_only_wake", eventLocalId: "session-follow-wake:fabricated", observations },
        })).toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        for (const row of [
            { seq: 4, sidechainId: null, messageRole: "user", transcriptObservationProvenance: null },
            { seq: 5, sidechainId: null, messageRole: "event", transcriptObservationProvenance: { kind: "dependent", source: "external" } },
        ]) {
            f.commitWakeEvent(eventLocalId, row);
            expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
                ...f.ackInput,
                acceptance: wakeAcceptance,
            })).toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
        }
        expect(f.edge.deliveredTranscriptSeq).toBe(1);

        f.commitWakeEvent(eventLocalId);
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput, acceptance: wakeAcceptance }))
            .toEqual({ ok: true, delivered: f.ackInput.consumed });
        expect(f.storage.sessionMessage.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { sessionId_localId: { sessionId: "destination", localId: eventLocalId } },
        }));
    });

    it("binds a committed wake event to its exact source, generation, expected, and consumed batch", async () => {
        const f = runtimeFixture({ preset: 'everything' });
        const exactObservations = [{
            sourceSessionId: f.ackInput.sourceSessionId,
            policy: f.ackInput.policy,
            relation: 'follower' as const,
            expected: f.ackInput.expected,
            consumed: f.ackInput.consumed,
        }];
        const acceptanceFor = (
            publisherGeneration: string,
            observations: Parameters<typeof deriveSessionFollowWakeEventLocalIdV1>[0]['observations'],
        ) => {
            const eventLocalId = deriveSessionFollowWakeEventLocalIdV1({
                destinationSessionId: f.ackInput.destinationSessionId,
                publisherGeneration,
                observations,
            });
            f.commitWakeEvent(eventLocalId);
            return { kind: "context_only_wake" as const, eventLocalId, observations: [...observations] };
        };

        for (const acceptance of [
            acceptanceFor('3', [{ ...exactObservations[0], sourceSessionId: 'another-source' }]),
            acceptanceFor('3', [{ ...exactObservations[0], expected: { ...f.ackInput.expected, transcriptSeq: 0 } }]),
            acceptanceFor('3', [{ ...exactObservations[0], consumed: { ...f.ackInput.consumed, transcriptSeq: 1 } }]),
            acceptanceFor('4', exactObservations),
        ]) {
            f.storage.sessionMessage.findUnique.mockClear();
            expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput, acceptance }))
                .toEqual({ ok: false, rejection: "provider_acceptance_unverified" });
            expect(f.storage.sessionMessage.findUnique).not.toHaveBeenCalled();
            expect(f.edge.deliveredTranscriptSeq).toBe(1);
        }

        const exactAcceptance = acceptanceFor('3', exactObservations);
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput, acceptance: exactAcceptance }))
            .toEqual({ ok: true, delivered: f.ackInput.consumed });
        expect(f.edge.deliveredTranscriptSeq).toBe(2);
    });

    it("rejects a principal substituted for the verified destination runtime", async () => {
        const f = runtimeFixture();
        const substitutedPrincipal = {
            kind: "destination_runtime",
            destinationRuntimeAccountId: "source-owner",
            authentication: f.observeInput.principal.authentication,
        } as const;
        expect(await observePendingSessionFollowForDestinationInTx(f.tx, { ...f.observeInput, principal: substitutedPrincipal })).toEqual({ currentSourceSessionIds: [], observations: [] });
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, { ...f.ackInput, principal: substitutedPrincipal }))
            .toEqual({ ok: false, rejection: "source_forbidden" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);
    });

    it("rechecks source authority before settling an already-committed wake event", async () => {
        const f = runtimeFixture({ preset: 'everything' });
        f.source.shares = [];

        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, {
            ...f.ackInput,
            acceptance: {
                kind: "context_only_wake",
                eventLocalId: deriveSessionFollowWakeEventLocalIdV1({
                    destinationSessionId: f.ackInput.destinationSessionId,
                    publisherGeneration: f.ackInput.expectedPublisherGeneration.toString(),
                    observations: [{
                        sourceSessionId: f.ackInput.sourceSessionId,
                        policy: f.ackInput.policy,
                        relation: 'follower',
                        expected: f.ackInput.expected,
                        consumed: f.ackInput.consumed,
                    }],
                }),
                observations: [{
                    sourceSessionId: f.ackInput.sourceSessionId,
                    policy: f.ackInput.policy,
                    relation: 'follower',
                    expected: f.ackInput.expected,
                    consumed: f.ackInput.consumed,
                }],
            },
        })).toEqual({ ok: false, rejection: "source_forbidden" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);
    });

    it.each(["revoked source", "broader audience", "public destination", "transferred custody"])(
        "rechecks %s after observation without acknowledging undisclosed progress", async (change) => {
            const f = runtimeFixture();
            expect((await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).observations).toHaveLength(1);
            if (change === "revoked source") f.source.shares = [];
            if (change === "broader audience") f.audience.push({ id: "new-reader" });
            if (change === "public destination") f.destination.publicShare = { expiresAt: null };
            if (change === "transferred custody") f.destination.accountId = "new-runtime";
            expect(await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).toEqual({ currentSourceSessionIds: [], observations: [] });
            expect(await acknowledgeSessionFollowFrontierInTx(f.tx, f.ackInput)).toEqual({ ok: false, rejection: "source_forbidden" });
            expect(f.edge.deliveredTranscriptSeq).toBe(1);
        },
    );

    it("retains archive dormancy and refuses a removed edge", async () => {
        const f = runtimeFixture();
        f.source.archivedAt = new Date();
        expect(await observePendingSessionFollowForDestinationInTx(f.tx, f.observeInput)).toEqual({ currentSourceSessionIds: [], observations: [] });
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, f.ackInput)).toEqual({ ok: false, rejection: "session_archived" });
        f.removeEdge();
        expect(await acknowledgeSessionFollowFrontierInTx(f.tx, f.ackInput)).toEqual({ ok: false, rejection: "edge_not_found" });
        expect(f.edge.deliveredTranscriptSeq).toBe(1);
    });
});
