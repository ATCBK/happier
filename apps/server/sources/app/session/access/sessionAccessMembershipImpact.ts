import type { Prisma } from "@prisma/client";
import type { Tx } from "@/storage/inTx";
import { applySessionAutoFollowForRelationshipChangeInTx } from "@/app/session/follow/accountFollowService";
import { resolveStructuralSessionAccessForSessionsInTx, type EffectiveSessionAccess } from "./sessionAccess";
import { acquireSessionAccessTransitionCursorLocksInTx, applySessionAccessTransitionEffectsInTx } from "./sessionAccessTransitionEffects";

export type SessionAccessMembershipChange =
    | Readonly<{ kind: "teamMembership" | "teamRole"; teamId: string }>
    | Readonly<{ kind: "teamGroupMembership"; teamId: string; teamGroupIds: readonly string[] }>;

/**
 * Whether the enclosing mutation can create a genuinely new relationship.
 *
 * A reversible lifecycle transition — Team/Group archive and restore, or
 * membership suspend and reactivate — re-enables exactly the retained rows it
 * paused. Its effective-access transition looks identical to a first grant, so
 * the mutation owner, not the before/after comparison, is the authority on
 * whether prospective auto-follow may fire (§6.3: "archive restore … is not a
 * new qualifying event"). Revocation effects run for both origins.
 */
export type SessionAccessMembershipOrigin = "relationship_change" | "retained_lifecycle";

const captured = Symbol("Session access membership impact");
/** Transaction-local before-state; never persisted or accepted from a client. */
export interface SessionAccessMembershipImpact {
    readonly [captured]: {
        tx: Tx;
        origin: SessionAccessMembershipOrigin;
        readonly accountId: string;
        readonly sessions: ReadonlyMap<string, EffectiveSessionAccess | null>;
    };
}

/**
 * Merge a nested mutation's origin into an already captured Account impact.
 *
 * The original before-state remains authoritative for the enclosing atomic
 * mutation. A genuine relationship creation/removal upgrades that capture so
 * prospective effects may run, while a retained lifecycle operation can never
 * downgrade a relationship change observed elsewhere in the same transaction.
 */
export function mergeSessionAccessMembershipImpactOrigin(
    impact: SessionAccessMembershipImpact,
    origin: SessionAccessMembershipOrigin,
): void {
    if (origin === "relationship_change") impact[captured].origin = origin;
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
    origin: SessionAccessMembershipOrigin;
}>): Promise<ReadonlyMap<string, SessionAccessMembershipImpact>> {
    const accountIds = [...new Set(input.accountIds)];
    const predicates = buildAffectedSessionPredicates(input.changes);
    const sessionIds = predicates.length === 0 || accountIds.length === 0
        ? []
        : (await tx.session.findMany({ where: { OR: predicates }, select: { id: true } })).map(row => row.id);
    // Native Team/Group mutations may publish their Team projection inside
    // mutate, so acquire Session owners and readers before that first write.
    await acquireSessionAccessTransitionCursorLocksInTx(tx, sessionIds, accountIds);
    const access = await resolveStructuralSessionAccessForSessionsInTx(tx, { sessionIds, accountIds });
    return new Map(accountIds.map(accountId => [accountId, {
        [captured]: {
            tx,
            origin: input.origin,
            accountId,
            sessions: new Map(sessionIds.map(sessionId => [sessionId, access.get(sessionId)?.get(accountId) ?? null])),
        },
    }]));
}

/**
 * Apply only actual effective changes, without changing the explicit grant roster.
 *
 * Every captured Account is reconciled together so each affected Session runs
 * one batched after-resolution and one transition-effects pass, and prospective
 * auto-follow is invoked once per relationship kind for the Accounts that
 * genuinely gained read access through a relationship change.
 */
export async function applySessionAccessMembershipImpactsInTx(tx: Tx, input: Readonly<{
    impacts: Iterable<SessionAccessMembershipImpact>;
}>): Promise<void> {
    const beforeBySession = new Map<string, Map<string, EffectiveSessionAccess | null>>();
    const originByAccountId = new Map<string, SessionAccessMembershipOrigin>();
    for (const wrapper of input.impacts) {
        const impact = wrapper[captured];
        if (impact.tx !== tx) throw new Error("Membership impact must be applied in its capture transaction");
        // A retained-lifecycle capture never upgrades an Account that another
        // impact in the same transaction captured as a relationship change.
        if (impact.origin === "relationship_change") originByAccountId.set(impact.accountId, impact.origin);
        else if (!originByAccountId.has(impact.accountId)) originByAccountId.set(impact.accountId, impact.origin);
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
        accountIds: [...originByAccountId.keys()],
    });
    for (const sessionId of sessionIds) {
        const before = beforeBySession.get(sessionId)!;
        const resolved = afterAccess.get(sessionId);
        const after = new Map([...before.keys()].map(accountId => [accountId, resolved?.get(accountId) ?? null]));
        const effects = await applySessionAccessTransitionEffectsInTx(tx, { sessionId, before, after });

        const accountIdsByRelationship = new Map<"team" | "group", string[]>();
        for (const accountId of effects.grantedAccountIds) {
            if (originByAccountId.get(accountId) !== "relationship_change") continue;
            for (const relationship of after.get(accountId)?.relationshipKinds ?? []) {
                // Direct shares are applied by their own grant owner.
                if (relationship === "direct") continue;
                const accounts = accountIdsByRelationship.get(relationship) ?? [];
                accounts.push(accountId);
                accountIdsByRelationship.set(relationship, accounts);
            }
        }
        for (const [relationship, accountIds] of accountIdsByRelationship) {
            await applySessionAutoFollowForRelationshipChangeInTx(tx, { sessionId, accountIds, relationship });
        }
    }
}
