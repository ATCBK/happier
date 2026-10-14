import { isSessionPersonallyTrackedV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { resolveSessionPersonalEventEligibilityV1, type SessionPersonalEventKindV1, type SessionPersonalEventEligibilityReasonV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { db } from "@/storage/db";
import { admitSessionBackgroundDeliveryInTx } from "./backgroundDelivery";
import { listActivelyFollowingAccountIdsInTx, resolveSessionFollowFactsForAccountsInTx } from "./followFacts";

/**
 * Call only with an event and targets established by the committed semantic
 * mutation owner.
 *
 * Admission is the ordinary credential-qualified access decision taken with the
 * evidence background delivery actually has — none — so a recipient whose only
 * arm is a restricted Team is admitted only while that Team qualifies without
 * evidence. Owner, direct and inherited-authentication arms are unaffected.
 */
export async function listSessionPersonalEventRecipients(params: Readonly<{
    sessionId: string;
    event: SessionPersonalEventKindV1;
    targetAccountIds?: readonly string[];
}>): Promise<readonly { accountId: string; reason: SessionPersonalEventEligibilityReasonV1 }[]> {
    const session = await db.session.findUnique({ where: { id: params.sessionId }, select: { accountId: true, archivedAt: true, responsibleAccountId: true } });
    if (!session || session.archivedAt) return [];
    const targets = new Set(params.targetAccountIds ?? []);
    const following = await listActivelyFollowingAccountIdsInTx(db, { sessionId: params.sessionId });
    const candidateIds = [...new Set([session.accountId, ...following, ...targets])];
    const accounts = await db.account.findMany({ where: { id: { in: candidateIds }, status: "active" }, select: { id: true } });
    const accesses = await admitSessionBackgroundDeliveryInTx(db, {
        sessionId: params.sessionId,
        accountIds: accounts.map((row) => row.id),
    });
    const followFactsByAccountId = await resolveSessionFollowFactsForAccountsInTx(db, {
        sessionId: params.sessionId,
        accountIds: accounts.map((row) => row.id),
    });
    const recipients = accounts.map(account => {
        const access = accesses.get(account.id);
        if (!access) return null;
        const followFacts = followFactsByAccountId.get(account.id)!;
        const eligibility = resolveSessionPersonalEventEligibilityV1({
            event: params.event, isSessionOwner: session.accountId === account.id,
            accessible: true, accountSuspended: false, archived: false,
            responsible: session.responsibleAccountId === account.id,
            tracked: isSessionPersonallyTrackedV1({ ownerAccountId: session.accountId, viewerAccountId: account.id, followFacts }),
            targeted: targets.has(account.id), followFacts,
            capabilities: { canSubmitAgentInput: access.capabilities.submitAgentInput, canApprovePermissions: access.capabilities.approveRuntimePermissions },
        });
        if (!eligibility.eligible || !eligibility.reason) return null;
        return { accountId: account.id, reason: eligibility.reason };
    });
    return recipients.filter((row): row is NonNullable<typeof row> => row !== null);
}
