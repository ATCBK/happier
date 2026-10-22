import type { Prisma } from '@prisma/client';
import { readCurrentSessionIdsInTx } from '@/app/session/access/sessionReadAdmission';
import { isProjectedSessionStalledV1, projectSessionAwarenessRuntimeV1, resolveSessionAwarenessLifecycleV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { parseSessionRuntimeActivityProjectionFields } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { projectSessionAwarenessOperationalV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { readSessionAwarenessWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { type SessionManagedSessionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { type V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import {
    buildSessionAccessWhere,
    resolveEffectiveSessionAccessWhere,
    type SessionCollectiveAccessSnapshot,
} from '@/app/session/access/sessionAccessWhere';
import {
    hasSessionTranscriptPublicationLiveFacts,
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { parseStoredSessionLatestTurnStatus, readLatestTurnStatusObservedAt } from '@/app/session/listing/rows';
import { AUTOMATION_RUN_TERMINAL_STATES } from '@/app/automations/automationTypes';
import { readAccountFollowRuleReceiverCountsInTx } from '@/app/session/follow/accountFollowRuleService';
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';

/** Content-free turn-end review barrier; FIN owns the run lifecycle and terminal vocabulary. */
export async function readSessionPendingReviewRunCountsInTx(tx: Tx, sessionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const runs = await tx.automationRun.groupBy({
        by: ['causeSourceSessionId'],
        where: { causeSourceSessionId: { in: [...sessionIds] }, causeTriggerKind: 'sessionLifecycle',
            causeSessionLifecycleEvent: { in: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'] },
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } },
        _count: { _all: true },
    });
    return new Map(runs.flatMap((run) => run.causeSourceSessionId ? [[run.causeSourceSessionId, run._count._all] as const] : []));
}

const REPORT_SESSION_SELECT = {
    id: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    archivedAt: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    latestReadyEventSeq: true,
    latestReadyEventAt: true,
    meaningfulActivityAt: true,
    active: true,
    lastActiveAt: true,
    thinking: true,
    thinkingAt: true,
    runtimeActivityState: true,
    runtimeActivityActiveCount: true,
    runtimeActivityObservedAt: true,
    runtimeActivityRevision: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    pendingRequestObservedAt: true,
    pendingCount: true,
    pendingBlockedCount: true,
} as const satisfies Prisma.SessionSelect;

type ReportSessionRow = Prisma.SessionGetPayload<{ select: typeof REPORT_SESSION_SELECT }>;

function projectReportWorkStatus(row: ReportSessionRow, nowMs: number) {
    const liveFacts = hasSessionTranscriptPublicationLiveFacts(row);
    const lifecycle = {
        archivedAtMs: row.archivedAt?.getTime() ?? null,
        latestTurnStatus: liveFacts ? parseStoredSessionLatestTurnStatus(row.latestTurnStatus) : null,
        latestTurnStatusObservedAtMs: liveFacts ? readLatestTurnStatusObservedAt(row.latestTurnStatusObservedAt) : null,
        latestReadyEventSeq: liveFacts ? row.latestReadyEventSeq : null,
        latestReadyEventAtMs: liveFacts ? row.latestReadyEventAt?.getTime() ?? null : null,
        meaningfulActivityAtMs: row.meaningfulActivityAt?.getTime() ?? null,
    };
    const parsedActivity = liveFacts ? parseSessionRuntimeActivityProjectionFields({
        runtimeActivityState: row.runtimeActivityState,
        runtimeActivityActiveCount: row.runtimeActivityActiveCount,
        runtimeActivityObservedAt: readLatestTurnStatusObservedAt(row.runtimeActivityObservedAt),
        runtimeActivityRevision: readLatestTurnStatusObservedAt(row.runtimeActivityRevision),
    }) : null;
    const activity = parsedActivity?.kind === 'valid' ? parsedActivity.projection : null;
    const runtime = projectSessionAwarenessRuntimeV1({
        nowMs,
        lifecycle,
        runtime: {
            presence: 'unknown',
            active: liveFacts && row.active,
            lastObservedAtMs: liveFacts ? row.lastActiveAt.getTime() : null,
            thinking: liveFacts && row.thinking,
            thinkingAtMs: liveFacts ? row.thinkingAt?.getTime() ?? null : null,
            activityState: activity?.state ?? null,
            activityActiveCount: activity?.activeCount ?? null,
        },
        pending: liveFacts ? {
            hasPendingPermissionRequests: row.pendingPermissionRequestCount > 0,
            hasPendingUserActionRequests: row.pendingUserActionRequestCount > 0,
            pendingRequestObservedAtMs: row.pendingRequestObservedAt?.getTime() ?? null,
            queuedInputCount: row.pendingCount,
            blockedInputCount: row.pendingBlockedCount,
        } : {},
    });
    return {
        // Public runtime/lifecycle facts share Work's Protocol precedence. Content availability
        // remains a client verdict; no encryption/readability assertion is made by this count.
        status: readSessionAwarenessWorkStatusV1({ awareness: {
            runtime: runtime.runtime,
            freshness: runtime.freshness,
            lifecycle: resolveSessionAwarenessLifecycleV1(lifecycle, false),
            operational: projectSessionAwarenessOperationalV1({ runtime, lifecycle }),
        } }),
        // The existing presence publisher/timeout owns Session.active; only its own turn can stall it.
        stalled: liveFacts && !runtime.archived && isProjectedSessionStalledV1({ active: row.active, latestTurnStatus: lifecycle.latestTurnStatus }),
    };
}

export type SessionManagerContribution = Readonly<{
    sessionId: string; managerSessionId: string; working: boolean; needsYou: boolean; stalled: boolean; archived: boolean;
}>;

type SessionManagerProjectionRow = {
    id: string; ownerAccountId?: string; accountId?: string;
    manager?: V2SessionRecord['manager']; managedSessions?: V2SessionRecord['managedSessions'];
    receivedRuleCount?: number;
};

function projectCapturedReports<T extends SessionManagerProjectionRow>(sessions: readonly T[], contributions: readonly SessionManagerContribution[]): (T & SessionManagerProjectionRow)[] {
    const leads = new Map<string, string>();
    const reports = new Map<string, Required<SessionManagedSessionsV1>>();
    for (const contribution of contributions) {
        leads.set(contribution.sessionId, contribution.managerSessionId);
        const counts = reports.get(contribution.managerSessionId) ?? { total: 0, working: 0, needsYou: 0, stalled: 0, archived: 0 };
        counts.total += 1;
        if (contribution.archived) counts.archived += 1;
        if (contribution.working) counts.working += 1;
        if (contribution.needsYou) counts.needsYou += 1;
        if (contribution.stalled) counts.stalled += 1;
        reports.set(contribution.managerSessionId, counts);
    }
    return sessions.map(session => {
        const projected: T = { ...session };
        delete projected.manager;
        const lead = leads.get(session.id);
        if (lead) projected.manager = { sessionId: lead };
        projected.managedSessions = reports.get(session.id) ?? { total: 0, working: 0, needsYou: 0, stalled: 0, archived: 0 };
        return projected;
    });
}

/** Redact revoked endpoints without refreshing captured operational facts. */
export async function readmitCapturedSessionManagerReferencesInTx<T extends V2SessionRecord>(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication;
    accessMode: 'legacy_owner_or_direct' | 'effective_access_v1'; sessions: readonly T[];
    contributions: readonly SessionManagerContribution[];
}>): Promise<T[]> {
    const relatedIds = [...new Set(input.contributions.flatMap(row => [row.sessionId, row.managerSessionId]))];
    const current = await readCurrentSessionIdsInTx(tx, { ...input, sessionIds: relatedIds });
    return projectCapturedReports(input.sessions, input.contributions.filter(row =>
        current.has(row.sessionId) && current.has(row.managerSessionId)));
}

/** One batch acquires authorized relation facts for every returned list/detail row. */
export async function projectSessionManagerForRowsInTx<T extends SessionManagerProjectionRow>(tx: Tx, input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    sessions: readonly T[];
    accessMode: 'legacy_owner_or_direct' | 'effective_access_v1';
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
    nowMs: number;
    captureContributions?: (contributions: readonly SessionManagerContribution[]) => void;
    /** One containing listing snapshot may reuse its already admitted private membership read. */
    ruleReceiverCounts?: ReadonlyMap<string, number> | null;
}>) {
    if (input.sessions.length === 0) return [];
    const sessionIds = input.sessions.map((session) => session.id);
    const ruleCounts = input.ruleReceiverCounts === undefined
        ? await readAccountFollowRuleReceiverCountsInTx(tx, input) : input.ruleReceiverCounts;
    const pendingReviewRuns = await readSessionPendingReviewRunCountsInTx(tx, sessionIds);
    const edges = await tx.sessionFollowEdge.findMany({
        where: { relation: 'manager', OR: [{ sourceSessionId: { in: sessionIds } }, { destinationSessionId: { in: sessionIds } }] },
        select: { sourceSessionId: true, destinationSessionId: true },
    });
    const sessionEdges = edges.filter(hasSessionFollowSessionSource);
    const relatedIds = [...new Set(sessionEdges.flatMap((edge) => [edge.sourceSessionId, edge.destinationSessionId]))];
    let related: ReportSessionRow[] = [];
    if (relatedIds.length > 0) {
        const accessWhere = input.accessMode === 'legacy_owner_or_direct' && !input.authentication.sessionRuntimePrincipal
            ? buildSessionAccessWhere({ accountId: input.accountId, capability: 'readTranscript', mode: 'legacy_owner_or_direct' })
            : (await resolveEffectiveSessionAccessWhere({
                tx, accountId: input.accountId, capability: 'readTranscript', mode: 'effective_access_v1',
                authentication: input.authentication, collectiveAccessSnapshot: input.collectiveAccessSnapshot,
            })).where;
        related = await tx.session.findMany({
            where: { AND: [accessWhere, { id: { in: relatedIds } }] },
            select: REPORT_SESSION_SELECT,
        });
    }
    const readable = new Map(related.filter((row) => row.accountId === input.accountId || isSessionTranscriptShareable(row))
        .map((row) => [row.id, row]));
    const contributions: SessionManagerContribution[] = [];
    for (const edge of sessionEdges) {
        // Neither an unreadable parent nor an unreadable child leaks via counts or IDs.
        if (!readable.has(edge.sourceSessionId) || !readable.has(edge.destinationSessionId)) continue;
        const child = readable.get(edge.sourceSessionId)!;
        const { status, stalled } = projectReportWorkStatus(child, input.nowMs);
        contributions.push({ sessionId: edge.sourceSessionId, managerSessionId: edge.destinationSessionId, working: status.bucket === 'working' && !stalled,
            needsYou: status.bucket === 'needs_you', stalled, archived: child.archivedAt != null });
    }
    input.captureContributions?.(contributions);
    return projectCapturedReports(input.sessions.map(session => {
        const projected = { ...session, pendingReviewRuns: pendingReviewRuns.get(session.id) ?? 0 };
        delete projected.receivedRuleCount;
        const own = (session.ownerAccountId ?? session.accountId) === input.accountId;
        if (own && ruleCounts) projected.receivedRuleCount = ruleCounts.get(session.id) ?? 0;
        return projected;
    }), contributions);
}
