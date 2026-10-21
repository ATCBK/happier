import { compareSessionFollowFrontierProgressV1, isSessionFollowFrontierEqualV1, isSessionFollowTurnEqualV1, isSessionFollowConsumptionWithinCurrentV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { deriveSessionFollowWakeEventLocalIdV1, normalizeSessionFollowWakeObservationsV1,
    type SessionFollowAcknowledgeRequestV1, type SessionFollowObserveInactiveResponseV1,
    type SessionFollowObservePendingRequestV1, type SessionFollowObservePendingResponseV1,
    type SessionFollowPendingObservationV1, type SessionFollowSessionPendingObservationV1,
    type SessionFollowObserveSourceRoutesRequestV1, type SessionFollowObserveSourceRoutesResponseV1,
    SessionFollowRunOccurrenceRoutesResponseV1Schema, type SessionFollowRunOccurrenceRoutesRequestV1,
    type SessionFollowRunOccurrenceRoutesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { FollowPolicyV1Schema, isFollowPolicyEqualV1, serializeFollowPolicyV1, resolveFollowDeliveryV1, FOLLOW_EVENT_KINDS_V1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionPendingEnqueueByMachineRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { isDeepStrictEqual } from 'node:util';
import { AutonomousExchangeStateV1Schema, createAutonomousExchangeStateV1,
    readAutonomousExchangeAdmissionV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isPlainMachineDataKeyMarker } from '@happier-dev/protocol/machines/machineStoredContent';
import { type FollowSourceRelationV1, type SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { type SessionFollowSourceProjectionRequestV1, type SessionFollowSourceProjectionResponseV1, SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { deriveSessionFollowInputLocalIdV1, deriveSessionFollowOriginalOccurrenceKeyV1, isRunFollowOriginalV1, resolveExecutionRunFollowOccurrenceV1, type SessionFollowInputV1, type RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";

import {
    resolveEffectiveSessionAccess,
} from "@/app/session/access/sessionAccess";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import {
    assertSessionFollowSourceReadInTx,
    evaluateCurrentSessionContextPairInTx,
    mayInjectSessionContextInTx,
    resolveSessionFollowRuntimePrincipalAuthenticationInTx,
    type SessionFollowRuntimePrincipalV1,
} from "@/app/session/access/sessionContextInjection";
import { AccountStatus } from "@/storage/prisma";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import {
    readCurrentSourceSessionFollowFrontier,
    readStoredSessionFollowFrontier,
    writeSessionFollowFrontierColumns,
} from "@/app/session/relations/sessionEdgeFrontier";
import {
    hasCanonicalFollowProviderInputAcceptanceInTx,
    hasCanonicalFollowWakeEventAcceptanceInTx,
} from "./providerInputAcceptance";
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { verifyCurrentMaterializedRunnerPrincipalInTx } from "@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness";
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from "@/app/session/access/sessionRecipients";
import { readSessionPendingReviewRunCountsInTx } from '@/app/session/awareness/sessionManagerProjection';
import { parseStoredSessionRuntimeIssue, parseStoredSessionTurnTranscriptAnchors } from '@/app/session/turns/parseSessionTurnState';
import { isDeliveryMutedInTx } from './sessionDeliveryMuteService';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { discussionContextStorageAdapter } from '@/app/discussions/access';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { resolveWorkflowRunAccessInTx } from '@/app/workflows/workflowRunAccess';
import { isPublicSessionShareActive } from '@/app/share/publicSessionSharePublication';
import { canReadFollowSourceInTx } from './followSourceAdmission';
import { isExecutionRunFollowFrontierWitnessCurrentInTx, type ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { pageFollowListV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { readCurrentCommittedSessionInputMachineTargetInTx, readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { readAdmittedSessionFollowInputInTx, readSessionFollowOriginalOccurrenceFrontiersInTx, sessionFollowInputFrontiers, settleSessionFollowInputReasonsInTx, type SessionFollowInputRelation } from './sessionFollowRuleProgress';
import { readAutonomousExchangeSourceRoot, readReceiverAutonomousExchangeRootInTx,
    isAutonomousExchangeRootReceiptForAccount, type AutonomousExchangeRoot } from '@/app/session/messages/readAutonomousExchangeSourceRoot';
import { observeDiscussionFollowSourcesInTx } from './discussionFollowSource';
import { observeAccountDiscussionFollowOccurrenceInTx } from './discussionFollowSource';
import { SessionFollowRunOccurrenceRoutesRequestV1Schema, type SessionFollowSourceOccurrenceRoutesRequestV1,
    type SessionFollowSourceOccurrenceRoutesResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readExactCurrentPublisherAuthorityInTx } from '@/app/session/pending/hasExactCurrentPublisherAuthorityInTx';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { projectSessionFollowDefaultRelationshipsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveSessionFollowFactsInTx } from '@/app/session/personal/followFacts';
import { readOtherPersonalFollowerCensusInTx, readSessionPersonalFollowerCensusInTx, readAccountRunFollowDeliveryInTx } from './accountFollowService';
import type { SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { resolveWorkflowRunFollowEventV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { workflowRunAttentionWhere } from '@/app/workflows/workflowRunAttention';
export { attachDiscussionFollowSourceInTx, detachDiscussionFollowSourceInTx, invalidateDiscussionFollowDestinationsInTx,
    admitDiscussionFollowAddressingInTx, acknowledgeDiscussionFollowInputInTx } from './discussionFollowSource';
import {
    invalidateSessionRelationProjectionsInTx as invalidateSessionFollowDestinationsInTx,
} from "@/app/session/relations/sessionRelationChanges";

/**
 * The canonical `SessionFollowEdge` owner.
 *
 * Every HTTP route, generated Action, and internal Session-socket operation
 * delegates here, so authorization, seeding, dormancy and the acknowledgment
 * compare-and-set have exactly one implementation. This module stores no
 * content, no delivery Account, no configuring author, and no runtime state.
 */

const SESSION_SELECT = {
    id: true,
    accountId: true,
    archivedAt: true,
    publisherGeneration: true,
    seq: true,
    latestReadyEventSeq: true,
    agentStateVersion: true,
    latestTurnId: true,
    latestTurnStatus: true,
    active: true,
} as const;

const EDGE_SELECT = {
    sourceKey: true,
    sourceSessionId: true,
    sourceDiscussionId: true,
    sourceExecutionRunSessionId: true,
    sourceExecutionRunId: true,
    sourceWorkflowRunId: true,
    destinationSessionId: true,
    relation: true,
    attachedAt: true,
    deliveredTranscriptSeq: true,
    deliveredReadyEventSeq: true,
    deliveredAgentStateVersion: true,
    deliveredTurnId: true,
    deliveredTurnStatus: true,
    deliveredWorkflowRunRevision: true,
    deliveredExecutionRunTerminalEventId: true,
    policyJson: true,
} as const;

type OtherFollowSource = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;

function readStoredPolicy(raw: string): FollowPolicyV1 | null {
    try {
        const parsed = FollowPolicyV1Schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

async function canReadOtherFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherFollowSource; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    return canReadFollowSourceInTx(tx, input);
}

async function mayInjectOtherFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: OtherFollowSource; destinationSessionId: string; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    if (input.source.kind === 'discussion') {
        const participant = await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: {
            discussionId: input.source.discussionId, sessionId: input.destinationSessionId,
        } }, select: { removedAt: true } });
        if (!participant || participant.removedAt !== null) return false;
        return (await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication,
            source: { kind: 'resource', resourceId: input.source.discussionId, adapter: discussionContextStorageAdapter },
            destination: { kind: 'session', sessionId: input.destinationSessionId },
        })).ok;
    }
    if (input.source.kind === 'execution_run') {
        return (await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication,
            source: { kind: 'session', sessionId: input.source.sessionId },
            destination: { kind: 'session', sessionId: input.destinationSessionId },
        })).ok;
    }
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId },
        select: { id: true, accountId: true, publicShare: { select: { expiresAt: true } } } });
    if (!destination || isPublicSessionShareActive(destination.publicShare)) return false;
    const audience = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [destination.id] });
    const accounts = new Set([destination.accountId, ...(audience.get(destination.id) ?? [])]);
    for (const accountId of accounts) if (!await resolveWorkflowRunAccessInTx(tx, {
        actorAccountId: accountId, runId: input.source.runId })) return false;
    return true;
}

async function projectOtherFollowSourceInTx(tx: Tx, edge: Readonly<{
    sourceKey: string; destinationSessionId: string; policyJson: string; deliveredTranscriptSeq: number;
    deliveredWorkflowRunRevision: number | null;
    sourceSessionId: string | null; sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
}>, destinationArchived: boolean): Promise<FollowSourceRelationV1 | null> {
    const source = sourceForSessionFollowEdgeV1(edge);
    if (!source || source.kind === 'session') return null;
    const policy = readStoredPolicy(edge.policyJson);
    if (!policy) return null;
    let available = false;
    let pending: boolean | null = null;
    let archived = false;
    if (source.kind === 'discussion') {
        const row = await tx.discussion.findUnique({ where: { id: source.discussionId },
            select: { archivedAt: true, messageSeq: true } });
        available = row !== null;
        archived = row?.archivedAt != null;
        pending = row ? row.messageSeq > edge.deliveredTranscriptSeq : null;
    } else if (source.kind === 'workflow_run') {
        const row = await tx.automationRun.findUnique({ where: { id: source.runId },
            select: { workflowCustodyState: true, revision: true } });
        available = row?.workflowCustodyState !== null && row !== null;
        pending = available && row && edge.deliveredWorkflowRunRevision !== null
            ? row.revision > edge.deliveredWorkflowRunRevision : null;
    }
    return { source, destinationSessionId: edge.destinationSessionId, policy,
        relation: 'follower', deliveryState: destinationArchived || archived ? 'paused_archived' : 'eligible',
        sourceAvailability: available ? 'available' : 'unavailable', hasPendingUpdates: pending };
}

type SessionFollowSourceRunnerInput = Readonly<{
    principal: VerifiedEphemeralSessionRunnerPrincipal;
    destinationSessionId: string;
    request: SessionFollowSourceProjectionRequestV1;
}>;

async function admitSessionFollowSourceForRunnerInTx(
    tx: Tx,
    input: SessionFollowSourceRunnerInput,
) {
    if (input.principal.sessionId !== input.destinationSessionId) return null;
    if (input.request.sourceSessionId === input.destinationSessionId) return null;
    if (!await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)) return null;
    const custody = input.request.localInputId ? await readAdmittedSessionFollowInputInTx(tx, {
        principal: input.principal, accountId: input.principal.accountId, sourceSessionId: input.request.sourceSessionId,
        destinationSessionId: input.destinationSessionId, localInputId: input.request.localInputId,
    }) : null;
    const edge = input.request.localInputId ? null : readSessionEdge(await tx.sessionFollowEdge.findUnique({
        where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.request.sourceSessionId,
            relation: input.request.relation ?? 'follower',
        } },
        select: EDGE_SELECT,
    }));
    if (input.request.localInputId ? !custody : !edge) return null;
    if (edge?.relation === 'manager' && edge.attachedAt.getTime() !== input.request.attachedAt) return null;
    if (!(await assertSessionFollowSourceReadInTx(tx, {
        principal: input.principal,
        sourceSessionId: input.request.sourceSessionId,
        edge: { sourceSessionId: input.request.sourceSessionId, destinationSessionId: input.destinationSessionId },
    })).ok) return null;
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.archivedAt !== null || !await isActingAccountActive(tx, input.principal.accountId)) return null;
    if (!await canSubmitDestinationInput(
        tx,
        input.principal.accountId,
        input.destinationSessionId,
        await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal),
    )) return null;
    if (await isDeliveryMutedInTx(tx, { accountId: input.principal.accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId },
        candidate: { senderSessionId: input.request.sourceSessionId,
            source: { kind: 'session', sessionId: input.request.sourceSessionId } },
    }) !== false) return null;

    const source = await tx.session.findUnique({
        where: { id: input.request.sourceSessionId },
        select: {
            id: true, seq: true, encryptionMode: true, metadata: true, metadataLayoutVersion: true,
            archivedAt: true, createdAt: true, updatedAt: true, active: true, lastActiveAt: true,
            thinking: true, thinkingAt: true, latestTurnStatus: true, latestTurnStatusObservedAt: true,
            latestTurnId: true, lastRuntimeIssue: true,
            latestReadyEventSeq: true, latestReadyEventAt: true, meaningfulActivityAt: true,
            agentStateVersion: true, agentState: true, pendingPermissionRequestCount: true, pendingUserActionRequestCount: true,
            pendingRequestObservedAt: true, pendingCount: true, pendingBlockedCount: true,
            runtimeActivityState: true, runtimeActivityActiveCount: true,
        },
    });
    if (!source || source.archivedAt !== null || (source.encryptionMode !== "plain" && source.encryptionMode !== "e2ee")) return null;
    // The Runner reports the observation it is hydrating, but those sequence
    // numbers are never read authority. Bound the lower bound by the exact
    // transaction-loaded edge frontier so a stale or malicious caller cannot
    // replay already-delivered history, and reject an upper bound beyond the
    // source frontier this same transaction can currently observe. A cursor
    // above the frontier is a continuation inside the same pending range: a
    // wake scans past a full nonhuman page for protected human ingress (09D
    // §6.3), which delivery and ACK never skip.
    if (
        input.request.afterTranscriptSeq < (custody ? sessionFollowInputFrontiers(custody.delivery).expected.transcriptSeq : edge!.deliveredTranscriptSeq)
        || input.request.observedTranscriptSeq > source.seq
        || custody && input.request.observedTranscriptSeq > sessionFollowInputFrontiers(custody.delivery).observed.transcriptSeq
    ) return null;
    return { edge, source };
}

export async function projectSessionFollowSourceForRunnerInTx(
    tx: Tx, input: SessionFollowSourceRunnerInput,
): Promise<SessionFollowSourceProjectionResponseV1 | null> {
    const admission = await admitSessionFollowSourceForRunnerInTx(tx, input);
    if (!admission) return null;
    const { source } = admission;
    const pendingReviewRuns = await readSessionPendingReviewRunCountsInTx(tx, [source.id]);
    const fetched = await tx.sessionMessage.findMany({
        where: {
            sessionId: source.id,
            seq: { gt: input.request.afterTranscriptSeq, lte: input.request.observedTranscriptSeq },
        },
        select: {
            seq: true, localId: true, content: true, messageRole: true, createdAt: true,
            inputAdmissionReceipt: true, authorAccountId: true,
        },
        orderBy: { seq: 'asc' },
        take: input.request.limit + 1,
    });
    const hasMore = fetched.length > input.request.limit;
    const page = fetched.slice(0, input.request.limit);
    const accountActors = await projectSessionMessageAccountActors(tx, page);
    return SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1,
        source: {
            id: source.id,
            encryptionMode: source.encryptionMode,
            metadata: source.metadata,
            metadataLayoutVersion: source.metadataLayoutVersion,
            archivedAt: null,
            createdAt: source.createdAt.getTime(), updatedAt: source.updatedAt.getTime(),
            active: source.active, activeAt: source.lastActiveAt.getTime(),
            thinking: source.thinking, thinkingAt: source.thinkingAt?.getTime() ?? null,
            latestTurnStatus: source.latestTurnStatus,
            latestTurnId: source.latestTurnId,
            lastRuntimeIssue: parseStoredSessionRuntimeIssue(source.lastRuntimeIssue),
            latestTurnStatusObservedAt: source.latestTurnStatusObservedAt === null ? null : Number(source.latestTurnStatusObservedAt),
            latestReadyEventSeq: source.latestReadyEventSeq,
            latestReadyEventAt: source.latestReadyEventAt?.getTime() ?? null,
            meaningfulActivityAt: source.meaningfulActivityAt?.getTime() ?? null,
            agentStateVersion: source.agentStateVersion,
            agentState: source.agentState,
            pendingReviewRuns: pendingReviewRuns.get(source.id) ?? 0,
            pendingPermissionRequestCount: source.pendingPermissionRequestCount,
            pendingUserActionRequestCount: source.pendingUserActionRequestCount,
            pendingRequestObservedAt: source.pendingRequestObservedAt?.getTime() ?? null,
            pendingCount: source.pendingCount, pendingBlockedCount: source.pendingBlockedCount,
            runtimeActivityState: source.runtimeActivityState,
            runtimeActivityActiveCount: source.runtimeActivityActiveCount,
        },
        messages: page.map((message, index) => ({
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            ...(() => {
                const role = SessionMessageRoleSchema.safeParse(message.messageRole);
                return role.success ? { messageRole: role.data } : {};
            })(),
            createdAt: message.createdAt.getTime(),
            accountActor: accountActors[index] ?? null,
        })),
        hasMore,
    });
}

export async function projectSessionFollowSourceForRunner(input: SessionFollowSourceRunnerInput): Promise<SessionFollowSourceProjectionResponseV1 | null> {
    return await readSnapshotWithCurrentAdmission<SessionFollowSourceProjectionResponseV1 | null>(
        tx => projectSessionFollowSourceForRunnerInTx(tx, input), async (tx, captured) => {
            if (!captured) return null;
            const current = await admitSessionFollowSourceForRunnerInTx(tx, input);
            return current && current.source.encryptionMode === captured.source.encryptionMode ? captured : null;
        });
}

export type SessionFollowSourceFailure =
    | "invalid_parameters"
    | "session_not_found"
    | "account_inactive"
    | "session_archived"
    | "session_follow_same_session"
    | "session_follow_source_forbidden"
    | "session_follow_source_unavailable";

export type SessionFollowSourceResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: SessionFollowSourceFailure }>;

export type SessionFollowSourceKeyPreparationAdmission = Readonly<{
    destinationRuntimeAccountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    machineId: string;
}>;

type SessionRow = Readonly<{
    id: string;
    accountId: string;
    archivedAt: Date | null;
    publisherGeneration: bigint;
    seq: number;
    latestReadyEventSeq: number | null;
    agentStateVersion: number;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
    active: boolean;
}>;

type EdgeRow = Readonly<{
    sourceSessionId: string;
    destinationSessionId: string;
    deliveredTranscriptSeq: number;
    deliveredReadyEventSeq: number;
    deliveredAgentStateVersion: number;
    deliveredTurnId: string | null;
    deliveredTurnStatus: string | null;
    policy: FollowPolicyV1;
    policyJson: string;
    relation: 'follower' | 'manager';
    attachedAt: Date;
}>;

/** Session-only adapters never reinterpret a Discussion FK as a Session id. */
function readSessionEdge<T extends { sourceKey: string; sourceSessionId: string | null; sourceDiscussionId: string | null;
    sourceExecutionRunSessionId: string | null; sourceExecutionRunId: string | null; sourceWorkflowRunId: string | null;
    relation: string; policyJson: string }>(edge: T | null):
    (T & { sourceSessionId: string; relation: 'follower' | 'manager'; policy: FollowPolicyV1 }) | null {
    if (!edge || edge.sourceSessionId === null || (edge.relation !== 'follower' && edge.relation !== 'manager')) return null;
    const source = sourceForSessionFollowEdgeV1(edge);
    if (source?.kind !== 'session' || source.sessionId !== edge.sourceSessionId) return null;
    const policy = readStoredPolicy(edge.policyJson);
    return policy ? { ...edge, sourceSessionId: edge.sourceSessionId, relation: edge.relation, policy } : null;
}

function projectSource(edge: EdgeRow, source: SessionRow | null, dormant: boolean): SessionFollowSourceV1 {
    return {
        sourceSessionId: edge.sourceSessionId,
        destinationSessionId: edge.destinationSessionId,
        policy: edge.policy,
        deliveryState: dormant ? "paused_archived" : "eligible",
        hasPendingUpdates: source !== null && compareSessionFollowFrontierProgressV1(
            readStoredSessionFollowFrontier(edge),
            readCurrentSourceSessionFollowFrontier(source),
        ) === "ahead",
    };
}

async function loadSession(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    return await tx.session.findUnique({ where: { id: sessionId }, select: SESSION_SELECT });
}

async function isActingAccountActive(tx: Tx, accountId: string): Promise<boolean> {
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return account?.status === AccountStatus.active;
}

async function canReadSession(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.readTranscript === true;
}

async function canSubmitDestinationInput(tx: Tx, accountId: string, sessionId: string, authentication: SessionAccessAuthentication): Promise<boolean> {
    return (await resolveEffectiveSessionAccess(tx, { accountId, sessionId, authentication }))?.capabilities.submitAgentInput === true;
}

/** Resolve the single content-free audience for every outgoing relation. */
export async function resolveSessionFollowSourceChangeRecipientsInTx(
    tx: Tx,
    input: Readonly<{ sourceSessionId: string }>,
): Promise<ReadonlyMap<string, readonly string[]>> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sourceSessionId },
        orderBy: { destinationSessionId: "asc" },
        select: { destinationSessionId: true },
    });
    const destinationSessionIds = [...new Set(edges.map((edge) => edge.destinationSessionId))];
    return resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
        sessionIds: destinationSessionIds,
    });
}

/** One source original's currently authorized ordinary routes; membership grants no input authority. */
export async function observeSessionFollowSourceRoutes(input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    authentication: SessionAccessAuthentication;
    request: SessionFollowObserveSourceRoutesRequestV1;
}>): Promise<SessionFollowObserveSourceRoutesResponseV1> {
    return inReadSnapshot<SessionFollowObserveSourceRoutesResponseV1>(async tx => {
        const denied = { ok: false, v: 1, error: 'forbidden' } as const;
        if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)) return denied;
        const source = await tx.session.findUnique({ where: { id: input.sourceSessionId },
            select: { ...SESSION_SELECT, encryptionMode: true, responsibleAccountId: true } });
        const publisher = input.request.sourcePublisher;
        if (!source || source.archivedAt !== null) return denied;
        if (publisher) {
            if (source.accountId !== input.accountId
                || source.publisherGeneration.toString() !== publisher.publisherGeneration
                || !await readExactCurrentPublisherAuthorityInTx(tx, {
                accountId: input.accountId, sessionId: source.id, machineId: publisher.machineId,
                committedFence: new Date(publisher.committedFenceMs),
            }, input.accountId, source.id)) return denied;
        } else {
            // Receiver recovery uses its current Account authority, not a fabricated foreign publisher proof.
            const destinationSessionId = input.request.destinationSessionId;
            if (!destinationSessionId) return denied;
            const destination = await loadSession(tx, destinationSessionId);
            if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null
                || !(await mayInjectSessionContextInTx(tx, { configuringAccountId: input.accountId,
                    sourceSessionId: source.id, destinationSessionId: destination.id,
                    authentication: input.authentication })).ok) return denied;
        }
        const original = await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
            source, occurrence: input.request, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
        });
        if (!original) return denied;
        const edges = await tx.sessionFollowEdge.findMany({
            where: { sourceSessionId: source.id, relation: { in: ['follower', 'manager'] },
                ...(input.request.destinationSessionId ? { destinationSessionId: input.request.destinationSessionId } : {}) },
            select: EDGE_SELECT, orderBy: [{ destinationSessionId: 'asc' }, { relation: 'asc' }],
        });
        const routes: SessionFollowSessionPendingObservationV1[] = [];
        for (const row of edges) {
            const edge = readSessionEdge(row);
            if (!edge) continue;
            const destination = await loadSession(tx, edge.destinationSessionId);
            if (!destination || destination.archivedAt !== null) continue;
            const admission = await mayInjectSessionContextInTx(tx, {
                configuringAccountId: input.accountId, authentication: input.authentication,
                sourceSessionId: source.id, destinationSessionId: destination.id,
            });
            if (!admission.ok || await isDeliveryMutedInTx(tx, {
                accountId: admission.destinationRuntimeAccountId,
                receiver: { kind: 'session', sessionId: destination.id },
                candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } },
            }) !== false) continue;
            const delivered = readStoredSessionFollowFrontier(edge);
            const observed = { ...delivered, ...(input.request.sourceMessage
                ? { transcriptSeq: original.observed.transcriptSeq }
                : { agentStateVersion: original.observed.agentStateVersion }) };
            if (compareSessionFollowFrontierProgressV1(delivered, observed) !== 'ahead') continue;
            routes.push({ sourceSessionId: source.id, destinationSessionId: destination.id,
                relation: edge.relation, ...(edge.relation === 'manager' ? { attachedAt: edge.attachedAt.getTime() } : {}),
                policy: edge.policy, delivered, observed });
        }
        const access = await resolveEffectiveSessionAccess(tx, { accountId: input.accountId, sessionId: source.id,
            authentication: input.authentication });
        if (!access?.capabilities.readTranscript) return denied;
        const follow = await resolveSessionFollowFactsInTx(tx, { accountId: input.accountId, sessionId: source.id });
        return { ok: true, v: 1, sourceSessionId: source.id, routes, originalCreatedAt: original.originalCreatedAt,
            currentAccountFacts: { defaultRelationships: projectSessionFollowDefaultRelationshipsV1({
                responsibleForMe: source.responsibleAccountId === input.accountId, relationshipKinds: access.relationshipKinds,
            }), personalFollowSuppressed: follow.follows === false && follow.notificationLevel === 'none',
            hasPersistentFollow: follow.notificationLevel !== null } };
    });
}

/** Durable destination invalidation and socket hints share the commit boundary. */
export async function invalidateSessionFollowDestinationsForSourceChangeInTx(
    tx: Tx,
    input: Readonly<{ sourceSessionId: string; recipientsBySession?: ReadonlyMap<string, readonly string[]> }>,
): Promise<void> {
    const recipients = input.recipientsBySession ?? await resolveSessionFollowSourceChangeRecipientsInTx(tx, input);
    await invalidateSessionFollowDestinationsInTx(tx, recipients.keys(), recipients);
}

/** Run source changes invalidate configured receivers; their daemon reads the original owner. */
export async function invalidateRunFollowDestinationsInTx(tx: Tx, source: RunFollowOriginalV1['source']): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower' },
        select: { destinationSessionId: true } });
    await invalidateSessionFollowDestinationsInTx(tx, edges.map(edge => edge.destinationSessionId));
}

/** Invalidates surviving destinations before the database cascades source-edge deletion. */
export async function invalidateSessionFollowDestinationsForSessionDeleteInTx(
    tx: Tx,
    input: Readonly<{ sessionId: string }>,
): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { sourceSessionId: input.sessionId },
        select: { destinationSessionId: true },
    });
    await invalidateSessionFollowDestinationsInTx(
        tx,
        edges.map(({ destinationSessionId }) => destinationSessionId),
    );
}

/**
 * Lists the destination's authored sources, filtered to the sources this
 * Account may currently read. An unreadable source is omitted rather than
 * disclosed, and the projection is content-free: display titles live in
 * end-to-end encrypted Session metadata that the Home cannot read.
 */
export async function listSessionFollowSources(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
    cursor?: string;
    limit?: number;
}>): Promise<SessionFollowSourceResult<Readonly<{ sources: readonly FollowSourceRelationV1[]; continuation?: string }>>> {
    return await readSnapshotWithCurrentAdmission<SessionFollowSourceResult<Readonly<{ sources: readonly FollowSourceRelationV1[]; continuation?: string }>>>(async (tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const edges = await tx.sessionFollowEdge.findMany({
            where: { destinationSessionId: input.destinationSessionId, relation: 'follower' },
            select: EDGE_SELECT,
            orderBy: { sourceKey: "asc" },
        });
        const visible: FollowSourceRelationV1[] = [];
        for (const row of edges) {
            const edge = readSessionEdge(row);
            if (edge) {
                if (!await canReadSession(tx, input.accountId, edge.sourceSessionId, input.authentication)) continue;
                const source = await loadSession(tx, edge.sourceSessionId);
                const dormant = destination.archivedAt !== null || source === null || source.archivedAt !== null;
                visible.push(projectSource(edge, source, dormant));
            } else {
                const source = sourceForSessionFollowEdgeV1(row);
                if (!source || source.kind === 'session' || !await canReadOtherFollowSourceInTx(tx, {
                    accountId: input.accountId, source, authentication: input.authentication })) continue;
                const projected = await projectOtherFollowSourceInTx(tx, row, destination.archivedAt !== null);
                if (projected) visible.push(projected);
            }
        }
        return { ok: true, value: { sources: visible } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        if (!await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) return { ok: false, error: "session_not_found" };
        const visible: FollowSourceRelationV1[] = [];
        for (const source of captured.value.sources) {
            const permitted = 'sourceSessionId' in source
                ? await canReadSession(tx, input.accountId, source.sourceSessionId, input.authentication)
                : await canReadOtherFollowSourceInTx(tx, { accountId: input.accountId, source: source.source as OtherFollowSource,
                    authentication: input.authentication });
            if (permitted) visible.push(source);
        }
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'following', input.destinationSessionId]),
                rows: visible, key: row => 'sourceSessionId' in row
                    ? sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: row.sourceSessionId })
                    : sourceKeyForSessionFollowSourceV1(row.source as OtherFollowSource),
                cursor: input.cursor, limit: input.limit });
            return { ok: true, value: { sources: page.rows, ...(page.continuation ? { continuation: page.continuation } : {}) } };
        } catch { return { ok: false, error: 'invalid_parameters' }; }
    });
}

/** Reverse inspection is source-authorized; private people remain an anonymous census. */
export async function listSessionFollowers(input: Readonly<{
    accountId: string; sourceSessionId: string; authentication: SessionAccessAuthentication;
    cursor?: string; limit?: number;
}>): Promise<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>> {
    const admitSource = async (tx: Tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return 'account_inactive' as const;
        return await canReadSession(tx, input.accountId, input.sourceSessionId, input.authentication) ? null : 'session_not_found' as const;
    };
    return readSnapshotWithCurrentAdmission<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>>(async tx => {
        const error = await admitSource(tx);
        if (error) return { ok: false, error };
        const source = await loadSession(tx, input.sourceSessionId);
        if (!source) return { ok: false, error: 'session_not_found' };
        const rows = await tx.sessionFollowEdge.findMany({ where: { sourceSessionId: input.sourceSessionId,
            relation: { in: ['follower', 'manager'] } }, select: EDGE_SELECT,
            orderBy: [{ destinationSessionId: 'asc' }, { relation: 'asc' }] });
        const sources: SessionFollowSourceV1[] = [];
        for (const row of rows) {
            const edge = readSessionEdge(row);
            if (!edge || !await canReadSession(tx, input.accountId, edge.destinationSessionId, input.authentication)) continue;
            const destination = await loadSession(tx, edge.destinationSessionId);
            if (destination) sources.push({ ...projectSource(edge, source, source.archivedAt !== null || destination.archivedAt !== null), relation: edge.relation });
        }
        return { ok: true, value: { sources, ...await readSessionPersonalFollowerCensusInTx(tx,
            { accountId: input.accountId, sessionId: input.sourceSessionId }), rules: [], coverage: 'complete' } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        const error = await admitSource(tx);
        if (error) return { ok: false, error };
        const sources: SessionFollowSourceV1[] = [];
        for (const row of captured.value.sources) if ('sourceSessionId' in row
            && await canReadSession(tx, input.accountId, row.destinationSessionId, input.authentication)) sources.push(row);
        const census = await readSessionPersonalFollowerCensusInTx(tx, { accountId: input.accountId, sessionId: input.sourceSessionId });
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'followers', input.sourceSessionId]),
                rows: sources, key: row => JSON.stringify([row.destinationSessionId, row.relation]),
                cursor: input.cursor, limit: input.limit });
            return { ok: true, value: { ...captured.value, sources: page.rows,
                coverage: page.continuation ? 'partial' : 'complete',
                ...(page.continuation ? { continuation: page.continuation } : {}),
                ...census } };
        } catch { return { ok: false, error: 'invalid_parameters' }; }
    });
}

/** Reverse inspection for one exact non-Session source, with anonymous personal census. */
export async function listOtherSessionFollowers(input: Readonly<{
    accountId: string; source: OtherFollowSource; authentication: SessionAccessAuthentication;
    cursor?: string; limit?: number;
}>): Promise<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>> {
    const admit = async (tx: Tx) => {
        if (!await isActingAccountActive(tx, input.accountId)) return 'account_inactive' as const;
        return await canReadOtherFollowSourceInTx(tx, input) ? null : 'session_not_found' as const;
    };
    return readSnapshotWithCurrentAdmission<SessionFollowSourceResult<SessionFollowActionOutputV1['follow.list']>>(async tx => {
        const error = await admit(tx);
        if (error) return { ok: false as const, error };
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const rows = await tx.sessionFollowEdge.findMany({ where: { sourceKey, relation: 'follower' },
            select: EDGE_SELECT, orderBy: { destinationSessionId: 'asc' } });
        const sources: FollowSourceRelationV1[] = [];
        for (const row of rows) {
            if (JSON.stringify(sourceForSessionFollowEdgeV1(row)) !== JSON.stringify(input.source))
                throw new Error('Follow Run source digest collision');
            if (!await canReadSession(tx, input.accountId, row.destinationSessionId, input.authentication)) continue;
            const destination = await loadSession(tx, row.destinationSessionId);
            if (!destination) continue;
            const projected = await projectOtherFollowSourceInTx(tx, row, destination.archivedAt !== null);
            if (projected) sources.push(projected);
        }
        return { ok: true as const, value: { sources, rules: [], coverage: 'complete' as const,
            ...await readOtherPersonalFollowerCensusInTx(tx, { accountId: input.accountId, source: input.source }) } };
    }, async (tx, captured) => {
        if (!captured.ok) return captured;
        const error = await admit(tx);
        if (error) return { ok: false as const, error };
        const sources: FollowSourceRelationV1[] = [];
        for (const row of captured.value.sources) if (await canReadSession(tx, input.accountId,
            row.destinationSessionId, input.authentication)) sources.push(row);
        try {
            const page = pageFollowListV1({ scope: JSON.stringify([input.accountId, 'followers',
                    sourceKeyForSessionFollowSourceV1(input.source)]), rows: sources,
                key: row => JSON.stringify([row.destinationSessionId, row.relation ?? 'follower']),
                cursor: input.cursor, limit: input.limit });
            return { ok: true as const, value: { sources: page.rows, rules: [], coverage: 'complete' as const,
                ...await readOtherPersonalFollowerCensusInTx(tx, { accountId: input.accountId, source: input.source }),
                ...(page.continuation ? { continuation: page.continuation } : {}) } };
        } catch { return { ok: false as const, error: 'invalid_parameters' as const }; }
    });
}

/**
 * Creates or confirms one source relation for a destination Session.
 *
 * Creation seeds every delivered component from the source's current frontier
 * inside the same transaction, so enabling Follow never emits historical
 * context. Key readiness and daemon reachability are deliberately not
 * preconditions: a valid authorized edge is persisted and waits.
 */
export async function setSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    policy: FollowPolicyV1;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean; source: SessionFollowSourceV1 }>>> {
    const parsedPolicy = FollowPolicyV1Schema.safeParse(input.policy);
    if (!parsedPolicy.success) return { ok: false, error: 'invalid_parameters' };
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.sourceSessionId, input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };

        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        const source = await loadSession(tx, input.sourceSessionId);
        if (!source || !await canReadSession(tx, input.accountId, input.sourceSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        if (destination.archivedAt !== null || source.archivedAt !== null) {
            return { ok: false, error: "session_archived" };
        }

        const decision = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId,
            sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId,
            authentication: input.authentication,
        });
        if (!decision.ok) return { ok: false, error: "session_follow_source_forbidden" };

        const existing = readSessionEdge(await tx.sessionFollowEdge.findUnique({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                },
            },
            select: EDGE_SELECT,
        }));

        const policy = parsedPolicy.data;
        const policyJson = serializeFollowPolicyV1(policy);
        if (existing) {
            if (isFollowPolicyEqualV1(existing.policy, policy)) {
                return { ok: true, value: { changed: false, source: projectSource(existing, source, false) } };
            }
            const updated = readSessionEdge(await tx.sessionFollowEdge.update({
                where: { destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                } },
                data: { policyJson },
                select: EDGE_SELECT,
            }));
            if (!updated) throw new Error('Session Follow update lost its Session source identity');
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
            return { ok: true, value: { changed: true, source: projectSource(updated, source, false) } };
        }

        // Keep the resource idempotent under two concurrent first writers. The
        // preceding read preserves the ordinary `changed: false` response for
        // retries, while the upsert closes the unique-key race without a
        // catch-after-failed-transaction path (which PostgreSQL cannot use).
        const created = readSessionEdge(await tx.sessionFollowEdge.upsert({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: input.destinationSessionId,
                    sourceSessionId: input.sourceSessionId,
                    relation: 'follower',
                },
            },
            create: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: input.sourceSessionId }),
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: 'follower',
                policyJson,
                ...writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
            },
            update: {},
            select: EDGE_SELECT,
        }));
        if (!created) throw new Error('Session Follow creation lost its Session source identity');
        await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        return { ok: true, value: { changed: true, source: projectSource(created, source, false) } };
    });
}

/**
 * Removes one source relation. Removal is idempotent, requires only the
 * existing destination mutation authorization, and never grants source read;
 * following again later creates a fresh edge seeded to the then-current
 * frontier, so no historical content is disclosed by re-enabling.
 */
export async function removeSessionFollowSource(input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    sourceSessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.sourceSessionId, input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_not_found" };
        }
        if (!await canSubmitDestinationInput(tx, input.accountId, input.destinationSessionId, input.authentication)) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        const removed = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: 'follower',
            },
        });
        if (removed.count > 0) {
            await invalidateSessionFollowDestinationsInTx(tx, [input.destinationSessionId]);
        }
        return { ok: true, value: { changed: removed.count > 0 } };
    });
}

/**
 * Content-free server admission for the encrypted exact-Machine source-key
 * carrier. The DEK never enters this service: it validates only the current
 * caller, current context relation, pairwise audience policy, ephemeral destination
 * Machine, and exact AccessKey binding used to select the receiver room.
 */
type SessionFollowSourceKeyPreparerInput = Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    authentication: SessionAccessAuthentication;
    localInputId?: string;
}>;

async function prepareSessionFollowSourceKeyPreparerInTx(
    tx: Tx,
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: "account_inactive" };
    const [source, destination, edge, admittedInput] = await Promise.all([
        loadSession(tx, input.sourceSessionId),
        loadSession(tx, input.destinationSessionId),
        input.localInputId !== undefined ? null : tx.sessionFollowEdge.findFirst({
            where: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: { in: ['follower', 'manager'] },
            },
            select: EDGE_SELECT,
        }).then(readSessionEdge),
        input.localInputId === undefined ? null : readAdmittedSessionFollowInputInTx(tx, {
            accountId: input.accountId, sourceSessionId: input.sourceSessionId,
            destinationSessionId: input.destinationSessionId, localInputId: input.localInputId,
            authority: { kind: 'account', authentication: input.authentication },
        }),
    ]);
    if (!source || !destination || (!edge && !admittedInput)) {
        return { ok: false, error: "session_not_found" };
    }
    if (source.archivedAt !== null || destination.archivedAt !== null) {
        return { ok: false, error: "session_archived" };
    }
    // The custody owner has already admitted this exact Account, pair and
    // original. A missing/stale input never falls back to a configured edge.
    if (admittedInput) return { ok: true, value: { destinationRuntimeAccountId: destination.accountId } };
    const decision = await mayInjectSessionContextInTx(tx, {
        configuringAccountId: input.accountId,
        sourceSessionId: input.sourceSessionId,
        destinationSessionId: input.destinationSessionId,
        authentication: input.authentication,
    });
    if (!decision.ok) {
        return { ok: false, error: "session_follow_source_forbidden" };
    }
    return { ok: true, value: { destinationRuntimeAccountId: decision.destinationRuntimeAccountId } };
}

/** Resolves the authorized destination room; exact Runner authority is still required at dispatch. */
/** Non-Session refs use this same edge owner; raw Run fields are checked beside digest keys. */
export async function setOtherSessionFollowSource(input: Readonly<{
    accountId: string; destinationSessionId: string; source: OtherFollowSource;
    policy: FollowPolicyV1; authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean; source: FollowSourceRelationV1 }>>> {
    const parsed = FollowPolicyV1Schema.safeParse(input.policy);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    return inTx(async tx => {
        const sessionIds = input.source.kind === 'execution_run'
            ? [input.source.sessionId, input.destinationSessionId] : [input.destinationSessionId];
        await acquireSessionAccountCursorLocksInTx(tx, sessionIds, [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_not_found' };
        if (!await canReadOtherFollowSourceInTx(tx, input)) return { ok: false, error: 'session_not_found' };
        if (!await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)
            || !await mayInjectOtherFollowSourceInTx(tx, input))
            return { ok: false, error: 'session_follow_source_forbidden' };
        if (destination.archivedAt !== null) return { ok: false, error: 'session_archived' };
        if (input.source.kind === 'discussion') {
            const discussion = await tx.discussion.findUnique({ where: { id: input.source.discussionId },
                select: { archivedAt: true } });
            if (!discussion) return { ok: false, error: 'session_not_found' };
            if (discussion.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        if (input.source.kind === 'execution_run') {
            const parent = await loadSession(tx, input.source.sessionId);
            if (!parent) return { ok: false, error: 'session_not_found' };
            if (parent.archivedAt !== null) return { ok: false, error: 'session_archived' };
        }
        const sourceKey = sourceKeyForSessionFollowSourceV1(input.source);
        const key = { destinationSessionId: destination.id, sourceKey, relation: 'follower' };
        const existing = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: key }, select: EDGE_SELECT });
        if (existing && JSON.stringify(sourceForSessionFollowEdgeV1(existing)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        if (!existing && input.source.kind === 'execution_run') {
            const frontier = input.executionRunFrontier;
            if (!frontier || JSON.stringify(frontier.source) !== JSON.stringify(input.source)
                || !await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier))
                return { ok: false, error: 'session_follow_source_unavailable' };
        }
        const policyJson = serializeFollowPolicyV1(parsed.data);
        if (existing) {
            const projection = await projectOtherFollowSourceInTx(tx, existing, false);
            if (!projection) return { ok: false, error: 'session_follow_source_unavailable' };
            if (isFollowPolicyEqualV1(projection.policy, parsed.data))
                return { ok: true, value: { changed: false, source: projection } };
            const updated = await tx.sessionFollowEdge.update({ where: { destinationSessionId_sourceKey_relation: key },
                data: { policyJson }, select: EDGE_SELECT });
            await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
            const source = await projectOtherFollowSourceInTx(tx, updated, false);
            if (!source) throw new Error('Follow source update lost exact identity');
            return { ok: true, value: { changed: true, source } };
        }
        const raw = input.source.kind === 'discussion' ? { sourceDiscussionId: input.source.discussionId }
            : input.source.kind === 'workflow_run' ? { sourceWorkflowRunId: input.source.runId }
            : { sourceExecutionRunSessionId: input.source.sessionId, sourceExecutionRunId: input.source.runId };
        const baseline = input.source.kind === 'discussion'
            ? { deliveredTranscriptSeq: (await tx.discussion.findUniqueOrThrow({ where: { id: input.source.discussionId },
                select: { messageSeq: true } })).messageSeq }
            : input.source.kind === 'workflow_run'
                ? { deliveredWorkflowRunRevision: (await tx.automationRun.findUniqueOrThrow({ where: { id: input.source.runId },
                    select: { revision: true } })).revision }
                : { deliveredExecutionRunTerminalEventId: input.executionRunFrontier?.terminalEventId ?? null };
        const created = await tx.sessionFollowEdge.upsert({ where: { destinationSessionId_sourceKey_relation: key },
            create: { ...key, ...raw, ...baseline, policyJson }, update: {}, select: EDGE_SELECT });
        if (JSON.stringify(sourceForSessionFollowEdgeV1(created)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
        const source = await projectOtherFollowSourceInTx(tx, created, false);
        if (!source) throw new Error('Follow source create lost exact identity');
        return { ok: true, value: { changed: true, source } };
    });
}

export async function removeOtherSessionFollowSource(input: Readonly<{
    accountId: string; destinationSessionId: string; source: OtherFollowSource;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowSourceResult<Readonly<{ changed: boolean }>>> {
    return inTx(async tx => {
        await acquireSessionAccountCursorLocksInTx(tx, [input.destinationSessionId], [input.accountId]);
        if (!await isActingAccountActive(tx, input.accountId)) return { ok: false, error: 'account_inactive' };
        const destination = await loadSession(tx, input.destinationSessionId);
        if (!destination || !await canReadSession(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_not_found' };
        if (!await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication))
            return { ok: false, error: 'session_follow_source_forbidden' };
        const key = { destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(input.source), relation: 'follower' };
        const existing = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: key }, select: EDGE_SELECT });
        if (existing && JSON.stringify(sourceForSessionFollowEdgeV1(existing)) !== JSON.stringify(input.source))
            throw new Error('Follow Run source digest collision');
        if (!existing) return { ok: true, value: { changed: false } };
        await tx.sessionFollowEdge.delete({ where: { destinationSessionId_sourceKey_relation: key } });
        await invalidateSessionFollowDestinationsInTx(tx, [destination.id]);
        return { ok: true, value: { changed: true } };
    });
}

export async function authorizeSessionFollowSourceKeyPreparer(
    input: SessionFollowSourceKeyPreparerInput,
): Promise<SessionFollowSourceResult<Readonly<{ destinationRuntimeAccountId: string }>>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => await prepareSessionFollowSourceKeyPreparerInTx(tx, input), { isolationLevel: "Serializable" /* Follow source admission and access-change cleanup must preserve the same eligibility snapshot. */ });
}

export async function authorizeSessionFollowSourceKeyPreparation(input: Readonly<{
    accountId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    principal: VerifiedEphemeralSessionRunnerPrincipal;
    authentication: SessionAccessAuthentication;
    localInputId?: string;
}>): Promise<SessionFollowSourceResult<SessionFollowSourceKeyPreparationAdmission>> {
    if (input.sourceSessionId === input.destinationSessionId) {
        return { ok: false, error: "session_follow_same_session" };
    }
    return await inTx(async (tx) => {
        const prepared = await prepareSessionFollowSourceKeyPreparerInTx(tx, input);
        if (
            !prepared.ok
            || input.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.accountId !== prepared.value.destinationRuntimeAccountId
            || input.principal.sessionId !== input.destinationSessionId
            || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
        ) return prepared.ok ? { ok: false, error: "session_follow_source_forbidden" } : prepared;

        const binding = await tx.accessKey.findUnique({
                where: { accountId_machineId_sessionId: {
                    accountId: prepared.value.destinationRuntimeAccountId,
                    machineId: input.principal.machineId,
                    sessionId: input.destinationSessionId,
                } },
                select: {
                    machine: { select: {
                        accountId: true,
                        dataEncryptionKey: true,
                        kind: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                        runnerContentKeyBinding: true,
                    } },
                },
            });
        if (
            !binding
            || binding.machine.accountId !== prepared.value.destinationRuntimeAccountId
            || binding.machine.dataEncryptionKey === null
            || isPlainMachineDataKeyMarker(binding.machine.dataEncryptionKey)
            || binding.machine.kind !== "ephemeral_session_runner"
            || binding.machine.revokedAt !== null
            || binding.machine.replacedByMachineId !== null
            || binding.machine.runnerContentKeyBinding === null
        ) {
            return { ok: false, error: "session_follow_source_forbidden" };
        }
        return { ok: true, value: {
            destinationRuntimeAccountId: prepared.value.destinationRuntimeAccountId,
            destinationSessionId: input.destinationSessionId,
            sourceSessionId: input.sourceSessionId,
            machineId: input.principal.machineId,
        } };
    }, { isolationLevel: "Serializable" /* Follow source admission and access-change cleanup must preserve the same eligibility snapshot. */ });
}

/**
 * One pending observation for a destination Session. It is content-free: the
 * daemon receives source identities and frontiers, then fetches and decrypts
 * source material under its own authority.
 */
export type PendingSessionFollowObservationV1 = SessionFollowPendingObservationV1;

export type SessionFollowObservationResultV1 = Readonly<{
    currentSourceSessionIds: readonly string[];
    observations: readonly PendingSessionFollowObservationV1[];
    wakeAdmission?: FollowWakeAdmissionDecision;
}>;

type FollowWakeAdmissionDecision = Readonly<{ status: 'allowed' }>
    | Readonly<{ status: 'held'; code: 'autonomous_check_in' | 'session_input_target_unavailable' | 'session_input_cancelled' }>;

const unavailableWake = { status: 'held', code: 'session_input_target_unavailable' } as const;

/** Potential interrupt eligibility only; actual source event selection is the hydrated executor's job. */
function policyAllowsFollowWake(policy: FollowPolicyV1): boolean {
    return FOLLOW_EVENT_KINDS_V1.some(kind => kind === 'needs_you'
        ? (['decision', 'approval', 'blocked'] as const).some(type =>
            resolveFollowDeliveryV1({ policies: [policy], event: { kind, type } }).session.wake)
        : resolveFollowDeliveryV1({ policies: [policy], event: { kind } }).session.wake);
}

/** Read-only final pre-effect check over the exact normalized Follow batch. */
async function readFollowWakeAdmissionInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    destinationAccountId: string;
    publisherGeneration: bigint;
    pending: readonly SessionFollowSessionPendingObservationV1[];
    wakeAdmission: NonNullable<SessionFollowObservePendingRequestV1['wakeAdmission']>;
}>): Promise<FollowWakeAdmissionDecision> {
    let observations: ReturnType<typeof normalizeSessionFollowWakeObservationsV1>;
    try {
        observations = normalizeSessionFollowWakeObservationsV1(input.wakeAdmission.observations);
        if (deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId: input.destinationSessionId,
            publisherGeneration: input.publisherGeneration.toString(), observations,
        }) !== input.wakeAdmission.eventLocalId) return unavailableWake;
    } catch {
        return unavailableWake;
    }
    let commonRoot: AutonomousExchangeRoot | null = null;
    let needsReceiverRoot = false;
    for (const observation of observations) {
        const pending = input.pending.find(row => row.sourceSessionId === observation.sourceSessionId
            && row.relation === (observation.relation ?? 'follower'));
        if (!pending || pending.attachedAt !== observation.attachedAt
            || !isFollowPolicyEqualV1(pending.policy, observation.policy)
            || !isSessionFollowFrontierEqualV1(pending.delivered, observation.expected)
            || !isSessionFollowConsumptionWithinCurrentV1({ expected: observation.expected,
                observed: pending.observed, consumed: observation.consumed, current: pending.observed })) {
            return unavailableWake;
        }
        const source = await tx.session.findUnique({ where: { id: observation.sourceSessionId },
            select: { accountId: true, latestTurnId: true } });
        if (!source) return unavailableWake;
        if (source.accountId !== input.destinationAccountId) {
            const localRoot = await readReceiverAutonomousExchangeRootInTx(tx, {
                accountId: input.destinationAccountId, sessionId: input.destinationSessionId,
            });
            if (!localRoot) {
                // The first protected incoming Pending input becomes the
                // receiver-local root at admission, not during observation.
                needsReceiverRoot = true;
                continue;
            }
            if (commonRoot && (commonRoot.sessionId !== localRoot.sessionId || commonRoot.localId !== localRoot.localId)) return unavailableWake;
            commonRoot = localRoot;
            continue;
        }
        const selected = { localId: true, acceptedTurnId: true, targetExecutionRunId: true,
            inputAdmissionReceipt: true,
            autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true } as const;
        const changedInputs = observation.consumed.transcriptSeq > observation.expected.transcriptSeq
            ? await tx.sessionMessage.findMany({ where: { sessionId: observation.sourceSessionId,
                seq: { gt: observation.expected.transcriptSeq, lte: observation.consumed.transcriptSeq },
                acceptedTurnId: { not: null } }, select: selected, orderBy: { seq: 'asc' } })
            : [];
        // Agent-state and ready-event changes may not append an accepted input;
        // the current source Turn then supplies its already-bound original row.
        const sourceInputs = changedInputs.length > 0 ? changedInputs : source.latestTurnId
            ? await tx.sessionMessage.findMany({ where: { sessionId: observation.sourceSessionId,
                acceptedTurnId: source.latestTurnId }, select: selected, orderBy: { seq: 'asc' } })
            : [];
        const resolved = readAutonomousExchangeSourceRoot({ sourceSessionId: observation.sourceSessionId,
            actorAccountId: input.destinationAccountId, sourceInputs });
        if (resolved.status !== 'found') return unavailableWake;
        if (commonRoot && (commonRoot.sessionId !== resolved.root.sessionId
            || commonRoot.localId !== resolved.root.localId)) return unavailableWake;
        commonRoot = resolved.root;
    }
    const choice = input.wakeAdmission.autonomousCheckIn;
    if (!choice) return unavailableWake;
    if (!commonRoot) return needsReceiverRoot ? { status: 'allowed' } : unavailableWake;
    const original = await tx.sessionMessage.findUnique({ where: { sessionId_localId: {
        sessionId: commonRoot.sessionId, localId: commonRoot.localId } },
        select: { inputAdmissionReceipt: true, autonomousExchangeState: true, session: { select: { accountId: true } } } });
    if (!original || original.session.accountId !== input.destinationAccountId
        || !isAutonomousExchangeRootReceiptForAccount(original.inputAdmissionReceipt, input.destinationAccountId, commonRoot.sessionId)) return unavailableWake;
    const state = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(original.autonomousExchangeState);
    if (!state.success && original.autonomousExchangeState !== null) return unavailableWake;
    if (state.success && state.data.stopped) return { status: 'held', code: 'session_input_cancelled' };
    const current = state.success ? { ...state.data, afterTurns: choice.afterTurns }
        : createAutonomousExchangeStateV1(choice.afterTurns);
    return readAutonomousExchangeAdmissionV1(current) === 'check_in'
        ? { status: 'held', code: 'autonomous_check_in' }
        : { status: 'allowed' };
}

/**
 * Returns authoritative current admitted source membership alongside the
 * subset whose frontier has advanced. Both projections are produced by the
 * same Lane 04 runtime source-read assertion pass, so pending delivery is never
 * misused as lifecycle membership. Archived, removed, or denied edges are
 * absent from both projections.
 */
export async function observePendingSessionFollowForDestinationInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    includeManager?: boolean;
    inputLocalIds?: readonly string[];
    wakeAdmission?: SessionFollowObservePendingRequestV1['wakeAdmission'];
}>): Promise<SessionFollowObservationResultV1> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { currentSourceSessionIds: [], observations: [] };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.archivedAt !== null) return { currentSourceSessionIds: [], observations: [] };
    // Only the verified destination runtime observes its own edges; custody is
    // re-derived from the transaction, never trusted from the request.
    if (destination.accountId !== destinationRuntimeAccountId) return { currentSourceSessionIds: [], observations: [] };
    if (!await isActingAccountActive(tx, destinationRuntimeAccountId)) return { currentSourceSessionIds: [], observations: [] };
    if (!await canSubmitDestinationInput(tx, destinationRuntimeAccountId, destination.id, authentication)) return { currentSourceSessionIds: [], observations: [] };
    const result = await observePendingSessionFollowEdgesInTx(tx, {
        destinationSessionId: destination.id,
        destinationRuntimeAccountId,
        includeManager: input.includeManager,
        admitSource: async edge => (await assertSessionFollowSourceReadInTx(tx, {
            principal: input.principal, sourceSessionId: edge.sourceSessionId, edge,
        })).ok,
    });
    const admittedObservations: Extract<SessionFollowPendingObservationV1, { kind: 'admitted_input' | 'admitted_run_input' }>[] = [];
    for (const localInputId of new Set(input.inputLocalIds ?? [])) {
        const custody = await readAdmittedSessionFollowInputInTx(tx, { principal: input.principal,
            accountId: destinationRuntimeAccountId, destinationSessionId: destination.id, localInputId });
        if (!custody) continue;
        if ('source' in custody.delivery.original) {
            admittedObservations.push({ kind: 'admitted_run_input', localInputId,
                destinationSessionId: destination.id, delivery: custody.delivery });
            continue;
        }
        const frontiers = sessionFollowInputFrontiers(custody.delivery);
        admittedObservations.push({ kind: 'admitted_input' as const, localInputId,
            sourceSessionId: custody.delivery.original.sourceSessionId, destinationSessionId: destination.id,
            delivered: frontiers.expected, observed: frontiers.observed, delivery: custody.delivery });
    }
    // Native ready publication follows host Turn settlement and can lie beyond
    // its sealed transcript anchors. The existing ready frontier locates one
    // exact original; only indexed native acceptance permits this unsolicited
    // custody rejoin. Its encrypted completedTurnId is verified by the native
    // reader, never inferred here from the ready frontier or current Turn.
    for (const observation of result.observations) {
        if (!('sourceSessionId' in observation) || 'kind' in observation
            || observation.relation !== 'manager' || observation.observed.turn?.status !== 'completed') continue;
        const source = await tx.session.findUnique({ where: { id: observation.sourceSessionId },
            select: { latestReadyEventSeq: true } });
        if (!source?.latestReadyEventSeq) continue;
        const original = await tx.sessionMessage.findFirst({ where: { sessionId: observation.sourceSessionId,
            seq: source.latestReadyEventSeq, sidechainId: null }, select: { localId: true, seq: true } });
        if (!original?.localId) continue;
        const originalKey = deriveSessionFollowOriginalOccurrenceKeyV1({ sourceSessionId: observation.sourceSessionId,
            sourceMessage: { localId: original.localId, seq: original.seq } });
        if (!originalKey) continue;
        const accepted = await tx.sessionMessage.findFirst({ where: { sessionId: destination.id,
            acceptedFollowOriginalKey: originalKey, messageRole: 'user' }, select: { localId: true } });
        if (!accepted?.localId || admittedObservations.some(row => row.localInputId === accepted.localId)) continue;
        const custody = await readAdmittedSessionFollowInputInTx(tx, { principal: input.principal,
            accountId: destinationRuntimeAccountId, destinationSessionId: destination.id, localInputId: accepted.localId });
        if (!custody?.nativeAccepted || !('sourceMessage' in custody.delivery.original)
            || custody.delivery.original.sourceSessionId !== observation.sourceSessionId
            || custody.delivery.original.sourceMessage.localId !== original.localId
            || custody.delivery.original.sourceMessage.seq !== original.seq
            || !('event' in custody.delivery) || custody.delivery.event.kind !== 'finished') continue;
        const frontiers = sessionFollowInputFrontiers(custody.delivery);
        admittedObservations.push({ kind: 'admitted_input', localInputId: accepted.localId,
            sourceSessionId: observation.sourceSessionId, destinationSessionId: destination.id,
            delivered: frontiers.expected, observed: frontiers.observed, delivery: custody.delivery });
    }
    const combined = { ...result, currentSourceSessionIds: [...new Set([...result.currentSourceSessionIds,
        ...admittedObservations.flatMap(row => 'sourceSessionId' in row ? [row.sourceSessionId] : [])])], observations: [...result.observations, ...admittedObservations] };
    if (!input.wakeAdmission) return combined;
    return { ...combined, wakeAdmission: await readFollowWakeAdmissionInTx(tx, {
        destinationSessionId: destination.id, destinationAccountId: destinationRuntimeAccountId,
        publisherGeneration: destination.publisherGeneration,
        pending: result.observations.filter((observation): observation is SessionFollowSessionPendingObservationV1 => 'sourceSessionId' in observation && !('kind' in observation)), wakeAdmission: input.wakeAdmission,
    }) };
}

/** Exact retained input placement admits observation only, never a runtime principal. */
export async function observePendingSessionFollowForInactiveDestinationInTx(tx: Tx, input: Readonly<{
    accountId: string;
    destinationSessionId: string;
    machineId: string;
    installationId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFollowObserveInactiveResponseV1> {
    const denied = { ok: false, v: 1, error: 'forbidden' } as const;
    const destination = await loadSession(tx, input.destinationSessionId);
    if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null
        || !await isActingAccountActive(tx, input.accountId)
        || !await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)) return denied;
    const target = await readCurrentCommittedSessionInputMachineTargetInTx(tx, destination.id);
    if (!target || target.accountId !== input.accountId || target.machineId !== input.machineId
        || target.installationId !== input.installationId) return denied;
    const observation = await observePendingSessionFollowEdgesInTx(tx, {
        destinationSessionId: destination.id,
        destinationRuntimeAccountId: input.accountId,
        includeManager: true,
        admitSource: async edge => (await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionId: edge.sourceSessionId,
            destinationSessionId: destination.id, authentication: input.authentication,
        })).ok,
    });
    return { ok: true, v: 1, sessionId: destination.id, target,
        currentSourceSessionIds: [...observation.currentSourceSessionIds], observations: [...observation.observations] };
}

/** Current target, source reads and pairwise audience policy share one coherent snapshot. */
export async function observePendingSessionFollowForInactiveDestination(
    input: Parameters<typeof observePendingSessionFollowForInactiveDestinationInTx>[1],
): Promise<SessionFollowObserveInactiveResponseV1> {
    return inReadSnapshot(tx => observePendingSessionFollowForInactiveDestinationInTx(tx, input));
}

/**
 * A native terminal marker and its host Turn can describe the same outcome.
 * Rejoin the existing original-input custody even when the route ACK left the
 * Turn frontier behind, or the original is behind the next transcript page.
 * Only the host's exact Turn anchors establish membership; provider event ids
 * and the current transcript tail cannot substitute for that evidence.
 */
async function hasOriginalBackedTerminalFollowInputInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    sourceSessionId: string;
    turn: NonNullable<SessionFollowFrontierV1['turn']>;
}>): Promise<boolean> {
    const eventKind = input.turn.status === 'completed' ? 'finished'
        : input.turn.status === 'failed' || input.turn.status === 'cancelled' ? 'failed_or_stopped' : null;
    if (!eventKind) return false;
    const turn = await tx.sessionTurn.findUnique({ where: { sessionId_turnId: {
        sessionId: input.sourceSessionId, turnId: input.turn.id,
    } }, select: { status: true, transcriptAnchorsJson: true } });
    if (turn?.status !== input.turn.status) return false;
    const anchors = parseStoredSessionTurnTranscriptAnchors(turn.transcriptAnchorsJson);
    const start = anchors?.startSeqInclusive ?? anchors?.startUserMessageSeq;
    const end = anchors?.endSeqInclusive;
    if (start === undefined || end === undefined || end === null || end < start) return false;
    const originals = await tx.sessionMessage.findMany({ where: { sessionId: input.sourceSessionId,
        seq: { gte: start, lte: end }, localId: { not: null }, sidechainId: null,
    }, select: { localId: true, seq: true } });
    const originalKeys = new Set(originals.flatMap(row => row.localId ? [deriveSessionFollowOriginalOccurrenceKeyV1({
        sourceSessionId: input.sourceSessionId, sourceMessage: { localId: row.localId, seq: row.seq },
    })!] : []));
    if (!originalKeys.size) return false;
    const matchesOriginal = (receipt: unknown): boolean => {
        const delivery = readStoredSessionInputAdmissionReceipt(receipt)?.followDeliveryV1;
        return delivery !== undefined && 'sourceMessage' in delivery.original && 'event' in delivery
            && delivery.event.kind === eventKind && delivery.original.sourceSessionId === input.sourceSessionId
            && originalKeys.has(deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original)!);
    };
    const accepted = await tx.sessionMessage.findMany({ where: { sessionId: input.destinationSessionId,
        acceptedFollowOriginalKey: { in: [...originalKeys] }, messageRole: 'user',
    }, select: { inputAdmissionReceipt: true, localId: true, seq: true } });
    for (const row of accepted) {
        if (row.localId && matchesOriginal(row.inputAdmissionReceipt) && await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId, localInputId: row.localId,
            userMessageSeq: row.seq, requireProviderAccepted: true,
        })) return true;
    }
    // Before acceptance the same canonical original is already represented by
    // its Pending input. It must not also become optional manager context.
    const pendingIds = originals.flatMap(row => row.localId ? [deriveSessionFollowInputLocalIdV1({
        destinationSessionId: input.destinationSessionId,
        original: { sourceSessionId: input.sourceSessionId, sourceMessage: { localId: row.localId, seq: row.seq } },
    })] : []);
    const pending = await tx.sessionPendingMessage.findMany({ where: { sessionId: input.destinationSessionId,
        localId: { in: pendingIds },
    }, select: { inputAdmissionReceipt: true } });
    return pending.some(row => matchesOriginal(row.inputAdmissionReceipt));
}

async function observePendingSessionFollowEdgesInTx(tx: Tx, input: Readonly<{
    destinationSessionId: string;
    destinationRuntimeAccountId: string;
    includeManager?: boolean;
    admitSource: (edge: EdgeRow) => Promise<boolean>;
}>): Promise<SessionFollowObservationResultV1> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: { destinationSessionId: input.destinationSessionId,
            sourceSessionId: { not: null },
            relation: { in: input.includeManager ? ['follower', 'manager'] : ['follower'] } },
        select: EDGE_SELECT,
        orderBy: { sourceSessionId: "asc" },
    });

    const pending: PendingSessionFollowObservationV1[] = [];
    const currentSourceSessionIds: string[] = [];
    for (const row of edges) {
        const edge = readSessionEdge(row);
        if (!edge) continue;
        const source = await loadSession(tx, edge.sourceSessionId);
        if (!source || source.archivedAt !== null) continue;
        if (!await input.admitSource(edge)) continue;
        currentSourceSessionIds.push(edge.sourceSessionId);
        if (await isDeliveryMutedInTx(tx, { accountId: input.destinationRuntimeAccountId,
            receiver: { kind: 'session', sessionId: input.destinationSessionId },
            candidate: { senderSessionId: edge.sourceSessionId,
                source: { kind: 'session', sessionId: edge.sourceSessionId } },
        }) !== false) continue;
        const delivered = readStoredSessionFollowFrontier(edge);
        let observed = readCurrentSourceSessionFollowFrontier(source, edge.relation === 'manager');
        if (compareSessionFollowFrontierProgressV1(delivered, observed) !== "ahead") continue;
        if (edge.relation === 'manager' && observed.turn && await hasOriginalBackedTerminalFollowInputInTx(tx, {
            destinationSessionId: edge.destinationSessionId, sourceSessionId: source.id, turn: observed.turn,
        })) {
            // The daemon's original reader also consumes this observation's
            // numeric suffix. Mask only the overlapping lifecycle fact; a new
            // source original must remain reachable through that same reader.
            observed = { ...observed, turn: delivered.turn };
            if (compareSessionFollowFrontierProgressV1(delivered, observed) !== 'ahead') continue;
        }
        pending.push({
            sourceSessionId: edge.sourceSessionId,
            destinationSessionId: edge.destinationSessionId,
            delivered,
            observed,
            policy: edge.policy,
            relation: edge.relation,
            ...(edge.relation === 'manager' ? { attachedAt: edge.attachedAt.getTime() } : {}),
        });
    }
    return { currentSourceSessionIds: [...new Set(currentSourceSessionIds)], observations: [
        ...pending, ...await observeDiscussionFollowSourcesInTx(tx, input),
    ] };
}

/** The exact retained Run original is shared by Session routing and Account settlement. */
export async function readRunFollowOccurrenceInTx(tx: Tx, input: Readonly<{
    source: RunFollowOriginalV1['source']; original?: RunFollowOriginalV1;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<Readonly<{ original: RunFollowOriginalV1; event: Extract<SessionFollowInputV1, { original: RunFollowOriginalV1 }>['event'] }> | null> {
    const { source } = input;
    const requested = input.original;
    if (source.kind === 'execution_run') {
        const frontier = input.executionRunFrontier;
        if (!frontier || !isDeepStrictEqual(frontier.source, source)
            || !await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, frontier)) return null;
        const occurrence = resolveExecutionRunFollowOccurrenceV1({ ...frontier, sessionId: source.sessionId, runId: source.runId });
        return occurrence && (!requested || isDeepStrictEqual(requested, occurrence.original)) ? occurrence : null;
    }
    const run = await tx.automationRun.findUnique({ where: { id: source.runId },
        select: { revision: true, state: true, workflowCustodyState: true } });
    if (!run || run.revision < 1 || requested && (!('revision' in requested) || run.revision !== requested.revision)
        || run.workflowCustodyState === null) return null;
    const original = { source, revision: run.revision };
    const terminal = resolveWorkflowRunFollowEventV1({ state: run.state });
    if (terminal) return { original, event: terminal };
    const attentionRequired = await tx.automationRun.findFirst({ where: { id: source.runId,
        AND: [workflowRunAttentionWhere()] }, select: { id: true } }) !== null;
    const event = resolveWorkflowRunFollowEventV1({ state: run.state, attentionRequired });
    return event ? { original, event } : null;
}

/** The shared non-Session route read delegates facts to each existing source lifecycle. */
export async function observeFollowSourceOccurrenceRoutes(input: Readonly<{
    accountId: string; request: SessionFollowSourceOccurrenceRoutesRequestV1;
    authentication: SessionAccessAuthentication; executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<SessionFollowSourceOccurrenceRoutesResponseV1> {
    if ('source' in input.request && input.request.source.kind === 'discussion') {
        const request = input.request;
        const source = input.request.source;
        return await inReadSnapshot(async tx => {
            if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)
                || !await canReadFollowSourceInTx(tx, { ...input, source }))
                return { ok: false, v: 1, error: 'forbidden' };
            const discussion = await observeAccountDiscussionFollowOccurrenceInTx(tx, { ...input,
                request: { v: 1, source, ...('messageId' in request ? { messageId: request.messageId } : {}) } });
            return discussion ? { ok: true, v: 1, discussion } : { ok: false, v: 1, error: 'source_unavailable' };
        });
    }
    return observeRunFollowOccurrenceRoutes({ ...input, request: SessionFollowRunOccurrenceRoutesRequestV1Schema.parse(input.request) });
}

/** Retained Run adapter under the shared non-Session route owner. */
export async function observeRunFollowOccurrenceRoutes(input: Readonly<{
    accountId: string; request: SessionFollowRunOccurrenceRoutesRequestV1;
    authentication: SessionAccessAuthentication;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<SessionFollowRunOccurrenceRoutesResponseV1> {
    return await inReadSnapshot(async tx => {
        const requested = 'original' in input.request ? input.request.original : null;
        const source = requested?.source ?? ('source' in input.request ? input.request.source : input.request.original.source);
        const denied = { ok: false, v: 1, error: 'forbidden' } as const;
        const unavailable = { ok: false, v: 1, error: 'source_unavailable' } as const;
        if (input.authentication.sessionRuntimePrincipal || !await isActingAccountActive(tx, input.accountId)
            || !await canReadFollowSourceInTx(tx, { ...input, source })) return denied;
        const occurrence = await readRunFollowOccurrenceInTx(tx, { source, ...(requested ? { original: requested } : {}),
            executionRunFrontier: input.executionRunFrontier });
        if (!occurrence) return unavailable;
        const { original, event } = occurrence;
        const edges = await tx.sessionFollowEdge.findMany({ where: {
            sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
        }, select: EDGE_SELECT });
        const routes = [];
        for (const edge of edges) {
            if (!isDeepStrictEqual(sourceForSessionFollowEdgeV1(edge), source)) continue;
            if ('terminalEventId' in original ? edge.deliveredExecutionRunTerminalEventId === original.terminalEventId
                : 'revision' in original && (edge.deliveredWorkflowRunRevision ?? 0) >= original.revision) continue;
            if ('permissionRequests' in original) {
                const acceptedFollowOriginalKey = deriveSessionFollowOriginalOccurrenceKeyV1(original);
                const accepted = await tx.sessionMessage.findFirst({ where: { sessionId: edge.destinationSessionId,
                    acceptedFollowOriginalKey }, select: { localId: true, seq: true } });
                if (accepted?.localId && await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
                    destinationSessionId: edge.destinationSessionId, localInputId: accepted.localId,
                    userMessageSeq: accepted.seq, requireProviderAccepted: true,
                })) continue;
            }
            const policy = readStoredPolicy(edge.policyJson);
            if (!policy || !resolveFollowDeliveryV1({ policies: [policy], event }).selected) continue;
            const destination = await loadSession(tx, edge.destinationSessionId);
            if (!destination || destination.archivedAt !== null || destination.accountId !== input.accountId
                || !await canSubmitDestinationInput(tx, input.accountId, destination.id, input.authentication)
                || !await mayInjectOtherFollowSourceInTx(tx, { ...input, source, destinationSessionId: destination.id })
                || await isDeliveryMutedInTx(tx, { accountId: input.accountId,
                    receiver: { kind: 'session', sessionId: destination.id }, candidate: { source,
                        ...(source.kind === 'execution_run' ? { senderSessionId: source.sessionId } : {}) } }) !== false) continue;
            routes.push({ destinationSessionId: destination.id, relation: 'follower', attachedAt: edge.attachedAt.getTime(), policy,
                ...('revision' in original ? { expectedRevision: edge.deliveredWorkflowRunRevision ?? 0 }
                    : { expectedTerminalEventId: edge.deliveredExecutionRunTerminalEventId }) });
        }
        const personal = await readAccountRunFollowDeliveryInTx(tx, { ...input, original, event });
        return SessionFollowRunOccurrenceRoutesResponseV1Schema.parse({ ok: true, v: 1, original, event, routes,
            ...(personal ? { personal: { policy: personal.policy, alreadyRepresented: personal.represented } } : {}) });
    });
}

export type SessionFollowAcknowledgeRejection =
    | "edge_not_found"
    | "session_archived"
    | "stale_publisher_generation"
    | "stale_expected_frontier"
    | "stale_terminal_turn"
    | "invalid_consumed_frontier"
    | "provider_acceptance_unverified"
    | "source_forbidden";

export type SessionFollowAcknowledgeResult =
    | Readonly<{ ok: true; delivered: SessionFollowFrontierV1 }>
    | Readonly<{ ok: false; rejection: SessionFollowAcknowledgeRejection }>;

/** Input admission retains current ordinary/manager reasons beside one public original. */
export async function admitSessionFollowRelationsForInputInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string;
    delivery: NonNullable<SessionPendingEnqueueByMachineRequestV1['followDeliveryV1']>;
    relations: NonNullable<SessionPendingEnqueueByMachineRequestV1['followRelations']>;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    /** Only an immutable server-built Pending/Message receipt supplies this fact. */
    admittedOriginal?: true;
} & ({ sourceMachineId: string; authentication?: never } | { sourceMachineId?: never; authentication: SessionAccessAuthentication })>): Promise<readonly SessionFollowInputRelation[] | null> {
    if (!('sourceSessionId' in input.delivery.original)) {
        return admitRunFollowRelationsForInputInTx(tx, input);
    }
    const pair = { destinationSessionId: input.destinationSessionId, sourceSessionId: input.delivery.original.sourceSessionId };
    const source = await tx.session.findUnique({ where: { id: pair.sourceSessionId },
        select: { id: true, accountId: true, archivedAt: true, seq: true, agentStateVersion: true, encryptionMode: true } });
    if (!source || source.archivedAt !== null || !(await evaluateCurrentSessionContextPairInTx(tx, pair)).ok
        || !await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, { source, occurrence: input.delivery.original,
            delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null } })) return null;
    if (input.authentication) {
        if (input.authentication.sessionRuntimePrincipal || !(await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, authentication: input.authentication, ...pair,
        })).ok) return null;
    } else {
        const [sourceTarget, receiverTarget] = await Promise.all([
            source.accountId === input.accountId ? readCurrentCommittedSessionInputMachineTargetInTx(tx, source.id) : null,
            readCurrentCommittedSessionInputMachineTargetInTx(tx, pair.destinationSessionId),
        ]);
        if (![sourceTarget, receiverTarget].some(target => target?.accountId === input.accountId && target.machineId === input.sourceMachineId)) return null;
    }
    if (await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'session', sessionId: pair.destinationSessionId },
        candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } } }) !== false) return null;
    const relations: SessionFollowInputRelation[] = [];
    for (const relation of input.relations) {
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceSessionId_relation: {
            ...pair, relation: relation.relation,
        } } });
        if (!edge || relation.relation === 'manager' && edge.attachedAt.getTime() !== relation.attachedAt) return null;
        relations.push(edge);
    }
    return relations;
}

/** Run originals use the same relation, disclosure and Pending acceptance owners, never a parent transcript cursor. */
async function admitRunFollowRelationsForInputInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string; delivery: SessionFollowInputV1;
    relations: NonNullable<SessionPendingEnqueueByMachineRequestV1['followRelations']>;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
    admittedOriginal?: true;
    sourceMachineId?: string; authentication?: SessionAccessAuthentication;
}>): Promise<readonly SessionFollowInputRelation[] | null> {
    const original = input.delivery.original;
    if (!isRunFollowOriginalV1(original) || !('event' in input.delivery)) return null;
    const source = original.source;
    const authentication = input.authentication ?? backgroundDeliveryAuthentication();
    if (authentication.sessionRuntimePrincipal || !await canReadFollowSourceInTx(tx, { ...input, source, authentication })
        || !await mayInjectOtherFollowSourceInTx(tx, { ...input, source, authentication })) return null;
    const destination = await tx.session.findUnique({ where: { id: input.destinationSessionId },
        select: { accountId: true, archivedAt: true } });
    if (!destination || destination.accountId !== input.accountId || destination.archivedAt !== null) return null;
    if (input.sourceMachineId) {
        const receiver = await readCurrentCommittedSessionInputMachineTargetInTx(tx, input.destinationSessionId);
        const producer = source.kind === 'execution_run'
            ? await readCurrentCommittedSessionInputMachineTargetInTx(tx, source.sessionId) : undefined;
        if (![receiver, producer].some(target => target?.accountId === input.accountId
            && target.machineId === input.sourceMachineId)) return null;
    }
    if (await isDeliveryMutedInTx(tx, { accountId: input.accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId }, candidate: {
            source, ...(source.kind === 'execution_run' ? { senderSessionId: source.sessionId } : {}),
        } }) !== false) return null;
    const acceptedKey = deriveSessionFollowOriginalOccurrenceKeyV1(original);
    const accepted = acceptedKey ? await tx.sessionMessage.findFirst({ where: { sessionId: input.destinationSessionId,
        acceptedFollowOriginalKey: acceptedKey }, select: { localId: true, seq: true } }) : null;
    const nativeAccepted = accepted?.localId ? await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
        destinationSessionId: input.destinationSessionId, localInputId: accepted.localId,
        userMessageSeq: accepted.seq, requireProviderAccepted: true,
    }) : false;
    if (!nativeAccepted && !input.admittedOriginal) {
        const occurrence = await readRunFollowOccurrenceInTx(tx, { source, original,
            executionRunFrontier: input.executionRunFrontier });
        if (!occurrence || !isDeepStrictEqual(occurrence.event, input.delivery.event)) return null;
    }
    const relations: SessionFollowInputRelation[] = [];
    for (const reason of input.relations) {
        if (!('source' in reason) || !isDeepStrictEqual(reason.source, source)) return null;
        const edge = await tx.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: input.destinationSessionId, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
        } } });
        if (!edge || edge.attachedAt.getTime() !== reason.attachedAt
            || !isDeepStrictEqual(sourceForSessionFollowEdgeV1(edge), source)) return null;
        const policy = readStoredPolicy(edge.policyJson);
        if (!policy || !resolveFollowDeliveryV1({ policies: [policy], event: input.delivery.event }).selected) return null;
        if (!nativeAccepted && ('expectedRevision' in reason
            ? edge.deliveredWorkflowRunRevision !== reason.expectedRevision
            : edge.deliveredExecutionRunTerminalEventId !== reason.expectedTerminalEventId)) return null;
        relations.push(edge);
    }
    return relations.length ? relations : null;
}

/** Exact Pending→Message custody settles all admitted reasons without publishing private witnesses. */
export async function acknowledgeAdmittedSessionFollowInputInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    request: Extract<SessionFollowAcknowledgeRequestV1, { localInputId: string }>;
}>): Promise<SessionFollowAcknowledgeResult> {
    const request = input.request;
    const accountId = input.principal.kind === 'destination_runtime'
        ? input.principal.destinationRuntimeAccountId : input.principal.accountId;
    const readCurrentAdmission = async () => {
        const destination = await loadSession(tx, request.destinationSessionId);
        if (!destination || destination.accountId !== accountId || destination.archivedAt !== null
            || !await isActingAccountActive(tx, accountId)
            || !await canSubmitDestinationInput(tx, accountId, destination.id,
                await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal))) return { ok: false as const, rejection: 'source_forbidden' as const };
        if (destination.publisherGeneration.toString() !== request.expectedPublisherGeneration) return { ok: false as const, rejection: 'stale_publisher_generation' as const };
        const custody = await readAdmittedSessionFollowInputInTx(tx, { principal: input.principal, accountId,
            destinationSessionId: destination.id, ...('sourceSessionId' in request ? { sourceSessionId: request.sourceSessionId } : {}), localInputId: request.localInputId });
        if (!custody) return { ok: false as const, rejection: 'source_forbidden' as const };
        const represented = sessionFollowInputFrontiers(custody.delivery);
        if ('original' in request ? !isDeepStrictEqual(request.original, custody.delivery.original)
            : !isSessionFollowFrontierEqualV1(request.expected, represented.expected)
            || !isSessionFollowFrontierEqualV1(request.observed, represented.observed)
            || !isSessionFollowFrontierEqualV1(request.consumed, represented.observed)) return { ok: false as const, rejection: 'invalid_consumed_frontier' as const };
        if (request.acceptance.localInputId !== request.localInputId
            || !await hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: destination.id,
                localInputId: request.localInputId, userMessageSeq: request.acceptance.userMessageSeq,
                requireProviderAccepted: true })) return { ok: false as const, rejection: 'provider_acceptance_unverified' as const };
        return { ok: true as const, destination, custody, represented };
    };
    let admission = await readCurrentAdmission();
    if (!admission.ok) return admission;
    if (admission.custody.admissions.length > 0 || 'sourceSessionId' in admission.custody.delivery.original
        && admission.custody.relations.length > 0) {
        // Accepted progress publishes the destination Session. Admit its complete
        // audience and resource before KV/edge writes or terminal Account locks.
        await acquireSessionAccountCursorLocksInTx(tx, [admission.destination.id], [accountId]);
        admission = await readCurrentAdmission();
        if (!admission.ok) return admission;
    }
    const { custody, represented } = admission;
    const relationProgressAdvanced = 'sourceSessionId' in custody.delivery.original && custody.relations.some(edge =>
        edge.deliveredTranscriptSeq < represented.observed.transcriptSeq
        || edge.deliveredAgentStateVersion < represented.observed.agentStateVersion);
    if (!await settleSessionFollowInputReasonsInTx(tx, { progresses: custody.admissions.map(row => row.progress),
        relations: custody.relations, observed: represented.observed, delivery: custody.delivery })) return { ok: false, rejection: 'stale_expected_frontier' };
    // Rule progress already publishes through its KV owner. Manager/explicit
    // progress must wake that same receiver recovery after an unconfirmed
    // middle admission, even if no new source notification will arrive.
    if (relationProgressAdvanced) await invalidateSessionFollowDestinationsInTx(tx, [admission.destination.id]);
    return { ok: true, delivered: represented.observed };
}

/**
 * Advances one edge's delivered frontier after the canonical provider-input
 * outcome reported acceptance.
 *
 * This is consumption progress, not exactly-once delivery proof. The write is a
 * compare-and-set over the complete expected stored tuple and the
 * destination's exact publisher generation, so a reordered or
 * duplicated acknowledgment can never regress or overwrite newer progress. The
 * three numeric components must be monotone from the expected tuple and no
 * greater than either the exact observed tuple or the current canonical source
 * values. An original prefix may retain the already-delivered turn while its
 * terminal outcome remains pending. Turns are identities, so the observed
 * turn must still equal the current source turn before any progress commits.
 */
export async function acknowledgeSessionFollowFrontierInTx(tx: Tx, input: Readonly<{
    principal: SessionFollowRuntimePrincipalV1;
    destinationSessionId: string;
    sourceSessionId: string;
    relation?: 'follower' | 'manager';
    attachedAt?: number;
    expectedPublisherGeneration: bigint;
    policy: FollowPolicyV1;
    expected: SessionFollowFrontierV1;
    observed: SessionFollowFrontierV1;
    consumed: SessionFollowFrontierV1;
    acceptance: SessionFollowAcknowledgeRequestV1['acceptance'];
}>): Promise<SessionFollowAcknowledgeResult> {
    if (
        input.principal.kind === "ephemeral_session_runner"
        && !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, input.principal)
    ) return { ok: false, rejection: "source_forbidden" };
    const destinationRuntimeAccountId = input.principal.kind === "destination_runtime"
        ? input.principal.destinationRuntimeAccountId
        : input.principal.accountId;
    const authentication = await resolveSessionFollowRuntimePrincipalAuthenticationInTx(tx, input.principal);
    const acceptance = input.acceptance;
    if (!acceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    switch (acceptance.kind) {
        case "context_only_wake":
            if (typeof acceptance.eventLocalId !== "string" || acceptance.eventLocalId.trim().length === 0) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        case "admitted_input":
            if (
                typeof acceptance.localInputId !== "string"
                || acceptance.localInputId.trim().length === 0
                || !(acceptance.userMessageSeq === null
                    || Number.isSafeInteger(acceptance.userMessageSeq) && acceptance.userMessageSeq >= 0)
            ) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
            break;
        default:
            return { ok: false, rejection: "provider_acceptance_unverified" };
    }
    const edge = readSessionEdge(await tx.sessionFollowEdge.findUnique({
        where: {
            destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: input.destinationSessionId,
                sourceSessionId: input.sourceSessionId,
                relation: input.relation ?? 'follower',
            },
        },
        select: EDGE_SELECT,
    }));
    if (!edge) return { ok: false, rejection: "edge_not_found" };
    const policy = FollowPolicyV1Schema.safeParse(input.policy);
    if (!policy.success || !isFollowPolicyEqualV1(edge.policy, policy.data)) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    if (edge.relation === 'manager' && edge.attachedAt.getTime() !== input.attachedAt) {
        return { ok: false, rejection: 'stale_expected_frontier' };
    }
    const stored = readStoredSessionFollowFrontier(edge);
    if (!isSessionFollowFrontierEqualV1(stored, input.expected)) {
        return { ok: false, rejection: "stale_expected_frontier" };
    }

    const destination = await loadSession(tx, input.destinationSessionId);
    const source = await loadSession(tx, input.sourceSessionId);
    if (!destination || !source) return { ok: false, rejection: "edge_not_found" };
    if (destination.accountId !== destinationRuntimeAccountId
        || !await isActingAccountActive(tx, destinationRuntimeAccountId)
        || !await canSubmitDestinationInput(
            tx,
            destinationRuntimeAccountId,
            destination.id,
            authentication,
        )
        || !(await assertSessionFollowSourceReadInTx(tx, {
            principal: input.principal,
            sourceSessionId: input.sourceSessionId,
            edge,
        })).ok) return { ok: false, rejection: "source_forbidden" };
    if (destination.archivedAt !== null || source.archivedAt !== null) {
        return { ok: false, rejection: "session_archived" };
    }
    if (destination.publisherGeneration !== input.expectedPublisherGeneration) {
        return { ok: false, rejection: "stale_publisher_generation" };
    }

    let hasCanonicalAcceptance: boolean;
    if (acceptance.kind === "context_only_wake") {
        let expectedEventLocalId: string;
        try {
            expectedEventLocalId = deriveSessionFollowWakeEventLocalIdV1({
                destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(),
                observations: acceptance.observations,
            });
        } catch {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        const acceptedObservation = acceptance.observations.find(
            (observation) => observation.sourceSessionId === input.sourceSessionId
                && (observation.relation ?? 'follower') === (input.relation ?? 'follower'),
        );
        if (
            expectedEventLocalId !== acceptance.eventLocalId
            || !acceptedObservation
            || acceptedObservation.attachedAt !== input.attachedAt
            || !isFollowPolicyEqualV1(acceptedObservation.policy, policy.data)
            || !isSessionFollowFrontierEqualV1(acceptedObservation.expected, input.expected)
            || !isSessionFollowFrontierEqualV1(acceptedObservation.consumed, input.consumed)
        ) {
            return { ok: false, rejection: "provider_acceptance_unverified" };
        }
        if (!policyAllowsFollowWake(edge.policy)) {
            // A stronger route for this exact source may cover a quiet route.
            // Its ACK may have committed first: current attachment/policy and
            // the accepted represented prefix remain the proof, not its old cursor.
            let covered = false;
            for (const represented of acceptance.observations) {
                if (represented.sourceSessionId !== input.sourceSessionId || !policyAllowsFollowWake(represented.policy)) continue;
                const stronger = readSessionEdge(await tx.sessionFollowEdge.findUnique({
                    where: { destinationSessionId_sourceSessionId_relation: {
                        destinationSessionId: destination.id, sourceSessionId: input.sourceSessionId, relation: represented.relation,
                    } }, select: EDGE_SELECT,
                }));
                const current = readCurrentSourceSessionFollowFrontier(source, stronger?.relation === 'manager');
                if (!stronger || !isFollowPolicyEqualV1(stronger.policy, represented.policy)
                    || (stronger.relation === 'manager' ? stronger.attachedAt.getTime() : undefined) !== represented.attachedAt
                    || represented.consumed.transcriptSeq < input.consumed.transcriptSeq
                    || represented.consumed.readyEventSeq < input.consumed.readyEventSeq
                    || represented.consumed.agentStateVersion < input.consumed.agentStateVersion
                    || !isSessionFollowConsumptionWithinCurrentV1({ expected: represented.expected,
                        observed: current, consumed: represented.consumed, current })) continue;
                covered = true;
                break;
            }
            if (!covered) {
                return { ok: false, rejection: "provider_acceptance_unverified" };
            }
        }
        hasCanonicalAcceptance = await hasCanonicalFollowWakeEventAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            eventLocalId: acceptance.eventLocalId,
        });
    } else {
        hasCanonicalAcceptance = await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
            destinationSessionId: input.destinationSessionId,
            localInputId: acceptance.localInputId,
            userMessageSeq: acceptance.userMessageSeq,
        });
    }
    if (!hasCanonicalAcceptance) {
        return { ok: false, rejection: "provider_acceptance_unverified" };
    }

    const current = readCurrentSourceSessionFollowFrontier(source, edge.relation === 'manager');
    if (!isSessionFollowConsumptionWithinCurrentV1({
        expected: input.expected,
        observed: input.observed,
        consumed: input.consumed,
        current,
    })) {
        return { ok: false, rejection: "invalid_consumed_frontier" };
    }
    if (!isSessionFollowTurnEqualV1(current.turn, input.observed.turn)) {
        return { ok: false, rejection: "stale_terminal_turn" };
    }

    const frontierWhere = writeSessionFollowFrontierColumns(input.expected);
    const written = await tx.sessionFollowEdge.updateMany({
        where: { destinationSessionId: input.destinationSessionId, sourceSessionId: input.sourceSessionId,
            relation: edge.relation, policyJson: edge.policyJson,
            ...(edge.relation === 'manager' ? { attachedAt: edge.attachedAt } : {}), ...frontierWhere },
        data: writeSessionFollowFrontierColumns(input.consumed),
    });
    if (written.count === 0) return { ok: false, rejection: "stale_expected_frontier" };
    return { ok: true, delivered: input.consumed };
}

/**
 * Reseed adapter consumed by the canonical Session archive/restore owner.
 *
 * Archiving either endpoint keeps the edge and makes it derived-dormant, so
 * this performs no write. When a Session becomes unarchived and its partner is
 * also unarchived, every delivered component is reseeded to the source's
 * then-current frontier in the same transaction, so updates accumulated while
 * archived are intentionally skipped rather than replayed.
 */
export async function reseedRestoredSessionFollowEdgesInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    archived: boolean;
}>): Promise<number> {
    if (input.archived) return 0;
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }],
            relation: 'follower',
            sourceSessionId: { not: null },
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    });

    let reseeded = 0;
    for (const edge of edges) {
        if (edge.sourceSessionId === null) continue;
        const source = await loadSession(tx, edge.sourceSessionId);
        const destination = await loadSession(tx, edge.destinationSessionId);
        if (!source || !destination) continue;
        if (source.archivedAt !== null || destination.archivedAt !== null) continue;
        await tx.sessionFollowEdge.update({
            where: {
                destinationSessionId_sourceSessionId_relation: {
                    destinationSessionId: edge.destinationSessionId,
                    sourceSessionId: edge.sourceSessionId,
                    relation: 'follower',
                },
            },
            data: writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)),
        });
        reseeded += 1;
    }
    return reseeded;
}

/**
 * Re-evaluates each Follow edge touching a Session whose effective audience or
 * access just changed. The complete current pair decision catches source-access
 * loss by any destination audience member as well as destination broadening;
 * it preserves an edge when the final post-mutation pair remains safe.
 * Restoring access does not
 * recreate the edge: the user follows again explicitly, seeded to current, so
 * content accumulated while unauthorized is never silently disclosed.
 */
export async function removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{
    sessionId: string;
}>): Promise<number> {
    const edges = await tx.sessionFollowEdge.findMany({
        where: {
            relation: 'follower',
            sourceSessionId: { not: null },
            OR: [
                { sourceSessionId: input.sessionId },
                { destinationSessionId: input.sessionId },
            ],
        },
        select: { sourceSessionId: true, destinationSessionId: true },
    });

    let removed = 0;
    const invalidatedDestinationSessionIds = new Set<string>();
    for (const edge of edges) {
        if (edge.sourceSessionId === null) continue;
        if ((await evaluateCurrentSessionContextPairInTx(tx, { ...edge, sourceSessionId: edge.sourceSessionId })).ok) continue;
        const deleted = await tx.sessionFollowEdge.deleteMany({
            where: {
                destinationSessionId: edge.destinationSessionId,
                sourceSessionId: edge.sourceSessionId,
                relation: 'follower',
            },
        });
        removed += deleted.count;
        if (deleted.count > 0) invalidatedDestinationSessionIds.add(edge.destinationSessionId);
    }
    await invalidateSessionFollowDestinationsInTx(tx, invalidatedDestinationSessionIds);
    return removed;
}
