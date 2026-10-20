import { isSessionPersonallyTrackedV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { resolveSessionPersonalEventEligibilityV1, type SessionPersonalEventKindV1, type SessionPersonalEventEligibilityReasonV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { db } from "@/storage/db";
import { admitSessionBackgroundDeliveryInTx } from "./backgroundDelivery";
import { listActivelyFollowingAccountIdsInTx, resolveSessionFollowFactsForAccountsInTx } from "./followFacts";
import { resolveSessionPersonalFollowEventV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { matchesPersonalFollowOnceOccurrenceV1, normalizeSessionFollowDefaultRulesV1, projectSessionFollowDefaultRelationshipsV1, resolveEffectiveAccountFollowPolicyV1, type PersonalFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { type FollowEventV1, type FollowPolicyV1, type ResolveFollowDeliveryV1Params } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readAccountDeliveryMutedForRecipientsInTx } from '@/app/session/follow/sessionDeliveryMuteService';
import type { Tx } from '@/storage/inTx';
import { acceptAccountSessionFollowOnceDeliveryInTx } from '@/app/session/follow/accountFollowService';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';

export type SessionPersonalEventRecipientsInput = Readonly<{
    sessionId: string;
    event: SessionPersonalEventKindV1;
    targetAccountIds?: readonly string[];
    onceOccurrence?: PersonalFollowOnceOccurrenceV1;
    followEvent?: FollowEventV1;
}>;
export type SessionPersonalEventRecipient = Readonly<{
    accountId: string;
    reason: SessionPersonalEventEligibilityReasonV1;
    follow?: ResolveFollowDeliveryV1Params;
    once?: Readonly<{ expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1 }>;
}>;

/**
 * Call only with an event and targets established by the committed semantic
 * mutation owner.
 *
 * Admission is the ordinary credential-qualified access decision taken with the
 * evidence background delivery actually has — none — so a recipient whose only
 * arm is a restricted Team is admitted only while that Team qualifies without
 * evidence. Owner, direct and inherited-authentication arms are unaffected.
 */
export async function listSessionPersonalEventRecipients(params: SessionPersonalEventRecipientsInput): Promise<readonly SessionPersonalEventRecipient[]> {
    return listSessionPersonalEventRecipientsInTx(db, params);
}

/** Same pure admission under the committed source writer's existing transaction. */
export async function listSessionPersonalEventRecipientsInTx(tx: Tx, params: SessionPersonalEventRecipientsInput,
): Promise<readonly SessionPersonalEventRecipient[]> {
    const session = await tx.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, archivedAt: true, responsibleAccountId: true } });
    if (!session || session.archivedAt) return [];
    const targets = new Set(params.targetAccountIds ?? []);
    const following = await listActivelyFollowingAccountIdsInTx(tx, { sessionId: params.sessionId });
    const candidateIds = [...new Set([session.accountId, ...following, ...targets])];
    const accounts = await tx.account.findMany({ where: { id: { in: candidateIds }, status: "active" }, select: {
        id: true, sessionAutoFollowAssigned: true, sessionAutoFollowDirect: true,
        sessionAutoFollowTeam: true, sessionAutoFollowGroup: true,
    } });
    // Only the committed targeted assignment uses operational defaults here.
    // Ongoing source occurrences remain with the authorized daemon/client rule
    // evaluator, which alone opens private arbitrary rule definitions.
    const assignmentServerId = params.event === 'assigned' && targets.size > 0
        ? await readCurrentServerIdentityId(process.env, tx) : null;
    const mutedByAccountId = await readAccountDeliveryMutedForRecipientsInTx(tx, {
        accountIds: accounts.map(row => row.id),
        candidate: { senderSessionId: params.sessionId, source: { kind: 'session', sessionId: params.sessionId } },
    });
    const accesses = await admitSessionBackgroundDeliveryInTx(tx, {
        sessionId: params.sessionId,
        accountIds: accounts.map((row) => row.id),
    });
    const followFactsByAccountId = await resolveSessionFollowFactsForAccountsInTx(tx, {
        sessionId: params.sessionId,
        accountIds: accounts.map((row) => row.id),
    });
    const recipients = await Promise.all(accounts.map(async account => {
        // Receiver/source mute suppresses personal routing, without changing
        // the Follow relation or the underlying source's Work visibility.
        if (mutedByAccountId.get(account.id) !== false) return null;
        const access = accesses.get(account.id);
        if (!access) return null;
        const followFacts = followFactsByAccountId.get(account.id)!;
        const rulePolicies = assignmentServerId && targets.has(account.id) && session.responsibleAccountId === account.id
            ? normalizeSessionFollowDefaultRulesV1({
                serverId: assignmentServerId,
                preferences: { assigned: account.sessionAutoFollowAssigned, direct: account.sessionAutoFollowDirect,
                    team: account.sessionAutoFollowTeam, group: account.sessionAutoFollowGroup },
                relationships: projectSessionFollowDefaultRelationshipsV1({
                    responsibleForMe: true, relationshipKinds: access.relationshipKinds,
                }),
                hasPersistentFollow: followFacts.notificationLevel !== null,
            }).rules.map(rule => rule.definition.policy)
            : [];
        const eligibility = resolveSessionPersonalEventEligibilityV1({
            event: params.event, isSessionOwner: session.accountId === account.id,
            accessible: true, accountSuspended: false, archived: false,
            responsible: session.responsibleAccountId === account.id,
            tracked: isSessionPersonallyTrackedV1({ ownerAccountId: session.accountId, viewerAccountId: account.id, followFacts }) || rulePolicies.length > 0,
            targeted: targets.has(account.id), followFacts,
            admittedRulePolicies: rulePolicies,
            onceOccurrence: params.onceOccurrence,
            followEvent: params.followEvent,
            capabilities: { canSubmitAgentInput: access.capabilities.submitAgentInput, canApprovePermissions: access.capabilities.approveRuntimePermissions },
        });
        if (!eligibility.eligible || !eligibility.reason) return null;
        const event = params.followEvent ?? resolveSessionPersonalFollowEventV1(params.event);
        const persistent = resolveEffectiveAccountFollowPolicyV1({ facts: followFacts, isSessionOwner: session.accountId === account.id });
        const policies: FollowPolicyV1[] = [...(persistent ? [persistent] : []), ...rulePolicies];
        let once: Readonly<{ expectedOnce: string; occurrence: PersonalFollowOnceOccurrenceV1 }> | undefined;
        if (params.onceOccurrence && followFacts.once && followFacts.onceAfterAgentStateVersion !== undefined
            && matchesPersonalFollowOnceOccurrenceV1({ once: followFacts.once,
                baseline: { agentStateVersion: followFacts.onceAfterAgentStateVersion }, occurrence: params.onceOccurrence })) {
            const row = await tx.accountSessionFollow.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: params.sessionId } }, select: { notifyOnce: true } });
            if (row?.notifyOnce) {
                once = { expectedOnce: row.notifyOnce, occurrence: params.onceOccurrence };
            }
        }
        return { accountId: account.id, reason: eligibility.reason, ...(event && policies.length ? { follow: { event, policies } } : {}),
            ...(once ? { once } : {}) };
    }));
    return recipients.filter((row): row is NonNullable<typeof row> => row !== null);
}

/**
 * Called only by the original committed source writer, while its exact occurrence
 * witness is current. Persisting the source reference is the accepted Inbox
 * effect; returned winners are ephemeral transport input, never replay proof.
 */
export async function acceptSessionPersonalEventOnceInTx(tx: Tx, params: SessionPersonalEventRecipientsInput): Promise<readonly string[]> {
    if (!await isServerFeatureEnabledForHome('sessions.following', { tx })) return [];
    const occurrence = params.onceOccurrence;
    if (!occurrence) return [];
    const candidates = await listSessionPersonalEventRecipientsInTx(tx, params);
    const armed = candidates.filter(candidate => candidate.once !== undefined);
    if (!armed.length) return [];
    await acquireAccountChangePublicationLocksInTx(tx, armed.map(candidate => candidate.accountId), { includeSingleAccount: true });
    const accepted: string[] = [];
    for (const candidate of armed) {
        if (candidate.once && await acceptAccountSessionFollowOnceDeliveryInTx(tx, {
            accountId: candidate.accountId, sessionId: params.sessionId, ...candidate.once,
        })) accepted.push(candidate.accountId);
    }
    return accepted;
}
