import { inTx, type Tx } from '@/storage/inTx';
import { readSnapshotWithCurrentAdmission } from '@/storage/readSnapshotWithCurrentAdmission';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { SessionReportsToSetResultV1, SessionReportsToOptionsV1 } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';
import { resolveEffectiveSessionAccess, resolveEffectiveSessionAccessForSessionsInTx, type EffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { evaluateCurrentSessionContextPairInTx, mayInjectSessionContextInTx, mayInjectSessionContextForDestinationsInTx } from '@/app/session/access/sessionContextInjection';
import { acquireSessionReportsToHomeFenceInTx } from './sessionReportsToFence';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import { invalidateSessionRelationProjectionsInTx } from './sessionRelationChanges';
import { readCurrentSourceSessionFollowFrontier, writeSessionFollowFrontierColumns } from './sessionEdgeFrontier';

export interface SessionReportsToSetInput {
    accountId: string;
    sessionId: string;
    leadSessionId: string | null;
    expectedLeadSessionId: string | null;
    authentication: SessionAccessAuthentication;
}
export type SessionReportsToSetResult = SessionReportsToSetResultV1;

const SOURCE_SELECT = {
    id: true, updatedAt: true, archivedAt: true, seq: true, latestReadyEventSeq: true,
    agentStateVersion: true, latestTurnId: true, latestTurnStatus: true,
} as const;

function seedCurrentState(source: Parameters<typeof readCurrentSourceSessionFollowFrontier>[0]) {
    const current = readCurrentSourceSessionFollowFrontier(source);
    // No historical transcript. Leave the current state/terminal fact pending once.
    return writeSessionFollowFrontierColumns({
        ...current, readyEventSeq: Math.max(0, current.readyEventSeq - 1),
        agentStateVersion: Math.max(0, current.agentStateVersion - 1), turn: null,
    });
}

const forbidden = (reason: 'read' | 'input' | 'pairwise'): SessionReportsToSetResult =>
    ({ ok: false, error: 'reports_to_forbidden', reason });

type ReportsToAdmission = Readonly<{ ok: true }> | Extract<SessionReportsToSetResult, { ok: false }>;

function evaluateReportsToEndpointAdmission(accountActive: boolean, access: readonly (EffectiveSessionAccess | null | undefined)[],
    sessionId: string, leadSessionId: string | null): ReportsToAdmission {
    if (!accountActive || access.some(value => value?.capabilities.readTranscript !== true)) return forbidden('read');
    if (access.some(value => value?.capabilities.submitAgentInput !== true)) return forbidden('input');
    if (leadSessionId === sessionId) return { ok: false, error: 'reports_to_cycle' };
    return { ok: true };
}

/** The same endpoint and pairwise owner serves read-only options and final mutation. */
async function readReportsToAdmissionInTx(tx: Tx, input: Omit<SessionReportsToSetInput, 'expectedLeadSessionId'>,
    existingLeadSessionId: string | null): Promise<ReportsToAdmission> {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    if (account?.status !== 'active') return forbidden('read');
    const endpointIds = [...new Set([input.sessionId, ...(input.leadSessionId ? [input.leadSessionId]
        : existingLeadSessionId ? [existingLeadSessionId] : [])])];
    const access = await Promise.all(endpointIds.map((sessionId) => resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId, sessionId, authentication: input.authentication,
    })));
    const endpoints = evaluateReportsToEndpointAdmission(true, access, input.sessionId, input.leadSessionId);
    if (!endpoints.ok) return endpoints;
    if (input.leadSessionId !== null) {
        const pair = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionId: input.sessionId,
            destinationSessionId: input.leadSessionId, authentication: input.authentication,
        });
        if (!pair.ok) return forbidden('pairwise');
    }
    return { ok: true };
}

/** Same endpoint and pairwise decisions as final mutation, with page-oriented loading. */
async function readReportsToCandidateAdmissionsInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; candidateSessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ReportsToAdmission>> {
    const admissions = new Map<string, ReportsToAdmission>();
    const candidateIds = [...new Set(input.candidateSessionIds)];
    if (candidateIds.length === 0) return admissions;
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    if (account?.status !== 'active') return new Map(candidateIds.map(id => [id, forbidden('read')]));
    const access = await resolveEffectiveSessionAccessForSessionsInTx(tx, {
        ...input, sessionIds: [input.sessionId, ...candidateIds],
    });
    const pairCandidates: string[] = [];
    for (const id of candidateIds) {
        const admission = evaluateReportsToEndpointAdmission(true, [access.get(input.sessionId), access.get(id)], input.sessionId, id);
        admissions.set(id, admission);
        if (admission.ok) pairCandidates.push(id);
    }
    const pairs = await mayInjectSessionContextForDestinationsInTx(tx, {
        configuringAccountId: input.accountId, sourceSessionId: input.sessionId,
        destinationSessionIds: pairCandidates, authentication: input.authentication,
    });
    for (const id of pairCandidates) if (!pairs.get(id)?.ok) admissions.set(id, forbidden('pairwise'));
    return admissions;
}

async function reportsToWouldCycleInTx(tx: Tx, sessionId: string, leadSessionId: string): Promise<boolean> {
    return (await readReportsToCyclesInTx(tx, sessionId, [leadSessionId])).has(leadSessionId);
}

/** Walk only candidate ancestry, sharing already-read ancestors across the page. */
async function readReportsToCyclesInTx(tx: Tx, sessionId: string, leadSessionIds: readonly string[]): Promise<ReadonlySet<string>> {
    const parents = new Map<string, string | null>();
    let frontier = [...new Set(leadSessionIds)].filter(id => id !== sessionId);
    while (frontier.length > 0) {
        const edges = await tx.sessionReportsTo.findMany({
            where: { sessionId: { in: frontier } }, select: { sessionId: true, leadSessionId: true },
        });
        for (const id of frontier) parents.set(id, null);
        for (const edge of edges) parents.set(edge.sessionId, edge.leadSessionId);
        frontier = [...new Set(edges.map(edge => edge.leadSessionId))].filter(id => id !== sessionId && !parents.has(id));
    }
    const cycles = new Set<string>();
    for (const leadSessionId of leadSessionIds) {
        const visited = new Set([sessionId]);
        let ancestor: string | null = leadSessionId;
        while (ancestor !== null) {
            if (visited.has(ancestor)) { cycles.add(leadSessionId); break; }
            visited.add(ancestor);
            ancestor = parents.get(ancestor) ?? null;
        }
    }
    return cycles;
}

/** Reads only requested candidates; no grants, keys, runtime state or relation edges are written. */
export async function readSessionReportsToOptions(input: Readonly<{
    accountId: string; sessionId: string; candidateSessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<SessionReportsToOptionsV1> {
    return readSnapshotWithCurrentAdmission<SessionReportsToOptionsV1>(async (tx) => {
        const sourceAccess = await resolveEffectiveSessionAccess(tx, input);
        const existing = sourceAccess?.capabilities.readTranscript === true
            ? await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId }, select: { leadSessionId: true } }) : null;
        const currentLeadSessionId = existing?.leadSessionId ?? null;
        const admissions = await readReportsToCandidateAdmissionsInTx(tx, input);
        const cycles = await readReportsToCyclesInTx(tx, input.sessionId,
            [...admissions].filter(([, admission]) => admission.ok).map(([id]) => id));
        const candidates: SessionReportsToOptionsV1['candidates'] = [];
        for (const sessionId of [...new Set(input.candidateSessionIds)]) {
            const admission = admissions.get(sessionId)!;
            if (!admission.ok) {
                candidates.push({ sessionId, allowed: false,
                    reason: admission.error === 'reports_to_forbidden' ? admission.reason : 'cycle' });
            } else if (cycles.has(sessionId)) {
                candidates.push({ sessionId, allowed: false, reason: 'cycle' });
            } else {
                candidates.push({ sessionId, allowed: true });
            }
        }
        return { sessionId: input.sessionId, currentLeadSessionId, candidates };
    }, async (tx, captured) => {
        const source = await resolveEffectiveSessionAccess(tx, input);
        const canReadSource = source?.capabilities.readTranscript === true;
        const lead = canReadSource && captured.currentLeadSessionId !== null
            ? await resolveEffectiveSessionAccess(tx, { ...input, sessionId: captured.currentLeadSessionId }) : null;
        const currentLeadSessionId = lead?.capabilities.readTranscript === true ? captured.currentLeadSessionId : null;
        const admissions = await readReportsToCandidateAdmissionsInTx(tx, {
            ...input, candidateSessionIds: captured.candidates.filter(candidate => candidate.allowed).map(candidate => candidate.sessionId),
        });
        const candidates: SessionReportsToOptionsV1['candidates'] = [];
        for (const candidate of captured.candidates) {
            if (!candidate.allowed) { candidates.push(candidate); continue; }
            const current = admissions.get(candidate.sessionId)!;
            candidates.push(current.ok ? candidate : { sessionId: candidate.sessionId, allowed: false,
                reason: current.error === 'reports_to_forbidden' ? current.reason : 'cycle' });
        }
        return { ...captured, currentLeadSessionId, candidates };
    });
}

async function mutateSessionReportsToInTx(tx: Tx, input: SessionReportsToSetInput, createdChild: boolean): Promise<SessionReportsToSetResult> {
    // Every existing-child mutation takes the Home fence before *any* read.
    if (!createdChild) await acquireSessionReportsToHomeFenceInTx(tx);
    await acquireSessionAccountCursorLocksInTx(tx, [input.sessionId,
        ...(input.expectedLeadSessionId ? [input.expectedLeadSessionId] : []),
        ...(input.leadSessionId ? [input.leadSessionId] : [])]);
    const child = await tx.session.findUnique({ where: { id: input.sessionId }, select: SOURCE_SELECT });
    if (!child) return forbidden('read');
    const existing = await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId } });
    const admission = await readReportsToAdmissionInTx(tx, input, existing?.leadSessionId ?? null);
    if (!admission.ok) return admission;
    if ((existing?.leadSessionId ?? null) !== input.expectedLeadSessionId) return { ok: false, error: 'reports_to_cas_conflict' };
    if ((existing?.leadSessionId ?? null) === input.leadSessionId) {
        return { ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: existing?.attachedAt.getTime() ?? null };
    }
    if (!createdChild && input.leadSessionId !== null && await reportsToWouldCycleInTx(tx, input.sessionId, input.leadSessionId)) return { ok: false, error: 'reports_to_cycle' };
    // The Session's existing projection timestamp also separates detach/reattach
    // in one clock tick; no relation incarnation or historical tombstone is added.
    const changedAt = new Date(Math.max(Date.now(), child.updatedAt.getTime() + 1, (existing?.attachedAt.getTime() ?? -1) + 1));
    // Fresh creation publishes the row returned by its constructor. It has no
    // previous attachment to separate and must not make that publication stale.
    if (!createdChild) await tx.session.update({ where: { id: input.sessionId }, data: { updatedAt: changedAt } });
    if (input.leadSessionId === null) {
        await tx.sessionReportsTo.deleteMany({ where: { sessionId: input.sessionId } });
    } else {
        await tx.sessionReportsTo.upsert({
            where: { sessionId: input.sessionId },
            create: { sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: changedAt, ...seedCurrentState(child) },
            update: { leadSessionId: input.leadSessionId, attachedAt: changedAt, ...seedCurrentState(child) },
        });
    }
    await invalidateSessionRelationProjectionsInTx(tx, [input.sessionId,
        ...(existing ? [existing.leadSessionId] : []), ...(input.leadSessionId ? [input.leadSessionId] : [])]);
    return { ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: input.leadSessionId === null ? null : changedAt.getTime() };
}

export async function setSessionReportsToInTx(tx: Tx, input: SessionReportsToSetInput): Promise<SessionReportsToSetResult> {
    return mutateSessionReportsToInTx(tx, input, false);
}
export async function setSessionReportsTo(input: SessionReportsToSetInput): Promise<SessionReportsToSetResult> {
    return inTx((tx) => setSessionReportsToInTx(tx, input), { isolationLevel: "Serializable" /* ReportsTo access admission must serialize with access cleanup; the graph fence remains authoritative. */ });
}
export async function attachCreatedSessionReportsToInTx(tx: Tx, input: Omit<SessionReportsToSetInput, 'expectedLeadSessionId'>): Promise<SessionReportsToSetResult> {
    return mutateSessionReportsToInTx(tx, { ...input, expectedLeadSessionId: null }, true);
}
export async function removeUnsafeSessionReportsToEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<number> {
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true } });
    let removed = 0;
    const affected = new Set<string>();
    for (const edge of edges) {
        if ((await evaluateCurrentSessionContextPairInTx(tx, { sourceSessionId: edge.sessionId, destinationSessionId: edge.leadSessionId })).ok) continue;
        const deleted = await tx.sessionReportsTo.deleteMany({ where: edge });
        removed += deleted.count;
        if (deleted.count > 0) { affected.add(edge.sessionId); affected.add(edge.leadSessionId); }
    }
    await invalidateSessionRelationProjectionsInTx(tx, affected);
    return removed;
}

export async function applySessionArchiveTransitionToReportsToInTx(tx: Tx, input: Readonly<{ sessionId: string; wasArchived: boolean; isArchived: boolean }>): Promise<void> {
    if (input.wasArchived === input.isArchived) return;
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true, attachedAt: true } });
    for (const edge of edges) {
        if (input.isArchived) continue;
        const [child, lead] = await Promise.all([
            tx.session.findUnique({ where: { id: edge.sessionId }, select: SOURCE_SELECT }),
            tx.session.findUnique({ where: { id: edge.leadSessionId }, select: { archivedAt: true } }),
        ]);
        if (!child || !lead || child.archivedAt !== null || lead.archivedAt !== null) continue;
        await tx.sessionReportsTo.updateMany({ where: { sessionId: edge.sessionId, leadSessionId: edge.leadSessionId, attachedAt: edge.attachedAt }, data: seedCurrentState(child) });
    }
    await invalidateSessionRelationProjectionsInTx(tx, edges.flatMap((edge) => [edge.sessionId, edge.leadSessionId]));
}

/** Resolve the content-free lead invalidation audience before source publication starts. */
export async function resolveSessionReportsToSourceChangeRecipientsInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<ReadonlyMap<string, readonly string[]>> {
    const parent = await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId }, select: { leadSessionId: true } });
    return resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: parent ? [parent.leadSessionId] : [] });
}

export async function invalidateSessionReportsToForSourceChangeInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    recipientsBySession?: ReadonlyMap<string, readonly string[]>;
}>): Promise<void> {
    const recipients = input.recipientsBySession ?? await resolveSessionReportsToSourceChangeRecipientsInTx(tx, input);
    await invalidateSessionRelationProjectionsInTx(tx, recipients.keys(), recipients);
}

export async function invalidateSessionReportsToForSessionDeleteInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<void> {
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true } });
    await invalidateSessionRelationProjectionsInTx(tx, edges.flatMap((edge) => [edge.sessionId, edge.leadSessionId]).filter((id) => id !== input.sessionId));
}
