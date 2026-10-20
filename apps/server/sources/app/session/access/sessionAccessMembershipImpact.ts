import type { Prisma } from "@prisma/client";
import type { Tx } from "@/storage/inTx";
import { resolveStructuralSessionAccessForSessionsInTx, type EffectiveSessionAccess } from "./sessionAccess";
import { acquireSessionAccessTransitionCursorLocksInTx, applySessionAccessTransitionEffectsInTx, resolveAccessTransitionProjectionSessionIdsInTx } from "./sessionAccessTransitionEffects";
import { readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

export type SessionAccessMembershipChange =
    | Readonly<{ kind: "teamMembership" | "teamRole"; teamId: string }>
    | Readonly<{ kind: "teamGroupMembership"; teamId: string; teamGroupIds: readonly string[] }>;


const captured = Symbol("Session access membership impact");
/** Transaction-local before-state; never persisted or accepted from a client. */
export interface SessionAccessMembershipImpact {
    readonly [captured]: {
        tx: Tx;
        readonly accountId: string;
        readonly sessions: ReadonlyMap<string, EffectiveSessionAccess | null>;
    };
}


function buildAffectedSessionPredicates(
    changes: readonly SessionAccessMembershipChange[],
): Prisma.SessionWhereInput[] {
    return changes.map(change => {
        if (change.kind === "teamGroupMembership") return {
            groupGrants: { some: { teamGroupId: { in: [...change.teamGroupIds] }, teamGroup: { teamId: change.teamId } } },
        };
        const teamGrant = { teamGrants: { some: { teamId: change.teamId } } };
        // Team currentness also qualifies every containing Group membership;
        // a role change alone cannot change an exact Group grant's eligibility.
        return change.kind === "teamRole" ? teamGrant : { OR: [
            teamGrant,
            { groupGrants: { some: { teamGroup: { teamId: change.teamId } } } },
        ] };
    });
}

async function readAffectedSessionIdsInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
}>): Promise<string[]> {
    const predicates = buildAffectedSessionPredicates(input.changes);
    return predicates.length === 0 || input.accountIds.length === 0
        ? []
        : (await tx.session.findMany({ where: { OR: predicates }, select: { id: true } })).map(row => row.id);
}

/** Pure admission census before a Team writer takes actor or Team resource locks. */
export async function readSessionAccessMembershipChangeAudienceInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
    additionalAdmissionAccountIds?: readonly string[];
}>): Promise<Readonly<{ sessionIds: readonly string[]; accountIds: readonly string[] }>> {
    const affected = await readAffectedSessionIdsInTx(tx, input);
    const projectionSessionIds = await resolveAccessTransitionProjectionSessionIdsInTx(tx, affected);
    const audience = await readSessionAccountCursorAudienceInTx(tx, projectionSessionIds,
        [...input.accountIds, ...(input.additionalAdmissionAccountIds ?? [])]);
    return { sessionIds: audience.projectionSessionIds, accountIds: audience.accountIds };
}

/**
 * Capture before the native membership mutation destroys its old access facts.
 *
 * One Session query and one batched Account×Session access resolution serve the
 * whole affected set: a bulk Team or directory change must not degrade into a
 * per-Account, per-Session authorization loop inside the mutation transaction.
 */
export async function captureSessionAccessMembershipImpactsInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
}>): Promise<ReadonlyMap<string, SessionAccessMembershipImpact>> {
    const accountIds = [...new Set(input.accountIds)];
    const sessionIds = await readAffectedSessionIdsInTx(tx, { ...input, accountIds });
    // Native Team/Group mutations may publish their Team projection inside
    // mutate, so acquire Session owners and readers before that first write.
    await acquireSessionAccessTransitionCursorLocksInTx(tx, sessionIds, accountIds);
    const access = await resolveStructuralSessionAccessForSessionsInTx(tx, { sessionIds, accountIds });
    return new Map(accountIds.map(accountId => [accountId, {
        [captured]: {
            tx,
            accountId,
            sessions: new Map(sessionIds.map(sessionId => [sessionId, access.get(sessionId)?.get(accountId) ?? null])),
        },
    }]));
}

/**
 * Apply only actual effective changes, without changing the explicit grant roster.
 *
 * Every captured Account is reconciled together so each affected Session runs
 * one batched after-resolution and one transition-effects pass. Relationship
 * default rules evaluate later occurrences without enrolling personal follows.
 */
export async function applySessionAccessMembershipImpactsInTx(tx: Tx, input: Readonly<{
    impacts: Iterable<SessionAccessMembershipImpact>;
}>): Promise<void> {
    const beforeBySession = new Map<string, Map<string, EffectiveSessionAccess | null>>();
    const accountIds = new Set<string>();
    for (const wrapper of input.impacts) {
        const impact = wrapper[captured];
        if (impact.tx !== tx) throw new Error("Membership impact must be applied in its capture transaction");
        accountIds.add(impact.accountId);
        for (const [sessionId, beforeAccess] of impact.sessions) {
            const before = beforeBySession.get(sessionId) ?? new Map<string, EffectiveSessionAccess | null>();
            before.set(impact.accountId, beforeAccess);
            beforeBySession.set(sessionId, before);
        }
    }
    if (beforeBySession.size === 0) return;

    const sessionIds = [...beforeBySession.keys()];
    const afterAccess = await resolveStructuralSessionAccessForSessionsInTx(tx, {
        sessionIds,
        accountIds: [...accountIds],
    });
    for (const sessionId of sessionIds) {
        const before = beforeBySession.get(sessionId)!;
        const resolved = afterAccess.get(sessionId);
        const after = new Map([...before.keys()].map(accountId => [accountId, resolved?.get(accountId) ?? null]));
        await applySessionAccessTransitionEffectsInTx(tx, { sessionId, before, after });
    }
}
