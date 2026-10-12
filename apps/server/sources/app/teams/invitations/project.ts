import {
    deriveTeamInvitationStateV1,
    maskTeamInvitationRecipientEmail,
    TeamInvitationAdmissibleRoleV1Schema,
    type TeamInvitationRowV1,
} from "@happier-dev/protocol/teams";
import type { TeamInvitationRecord } from "./invitationLifecycle";
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
    type AccountDisplayProfileRow,
} from "@/app/account/profile/accountDisplayProfile";

/** Join the existing Account display projection in the invitation query, never one lookup per row. */
export const TEAM_INVITATION_DISPLAY_INCLUDE = {
    acceptedByAccount: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
} as const;

/**
 * The one projection from a stored invitation to its manager-visible row.
 *
 * It is the confinement boundary for the bearer: the digest is never carried out of
 * the server, and the recipient address is reduced to a mask so a Team manager list
 * cannot republish a full address. State is derived here at the caller's read time so
 * an expired row cannot be presented as active by a stale write.
 */
export function projectTeamInvitationRowV1(
    record: TeamInvitationRecord,
    now: Date,
    finishedByAccount: AccountDisplayProfileRow | null = null,
): TeamInvitationRowV1 {
    // An `owner` row can only mean corrupted or out-of-band data: the creation parser
    // rejects it, so failing here keeps a forbidden offer from reaching any client.
    const role = TeamInvitationAdmissibleRoleV1Schema.parse(record.role);
    const deliveryStatus = record.lastEmailDeliveryStatus;
    const deliveryAttemptedAt = record.lastEmailDeliveryAttemptAt;
    const state = deriveTeamInvitationStateV1({
        acceptedAt: record.acceptedAt?.getTime() ?? null,
        revokedAt: record.revokedAt?.getTime() ?? null,
        expiresAt: record.expiresAt.getTime(),
    }, now.getTime());
    return {
        id: record.id,
        teamId: record.teamId,
        state,
        role,
        historyAccess: record.historyAccess,
        recipientEmailMask: maskTeamInvitationRecipientEmail(record.recipientEmailNormalized),
        expiresAt: record.expiresAt.getTime(),
        createdAt: record.createdAt.getTime(),
        createdByAccountId: record.createdByAccountId,
        acceptedByAccountId: record.acceptedByAccountId,
        finishedAt: state === "accepted" ? record.acceptedAt!.getTime()
            : state === "revoked" ? record.revokedAt!.getTime()
                : state === "expired" ? record.expiresAt.getTime() : null,
        // Revocation stores no actor. Never substitute the creator or the current viewer.
        finishedByAccount: state === "accepted" && finishedByAccount?.id === record.acceptedByAccountId
            ? projectAccountDisplayProfileV1(finishedByAccount) : null,
        // Both coarse fields are written together by the delivery boundary. A half
        // present pair is an unknown result, never a claim that mail was submitted.
        lastEmailDelivery: deliveryStatus !== null && deliveryAttemptedAt !== null
            ? { status: deliveryStatus, attemptedAt: deliveryAttemptedAt.getTime() }
            : null,
    };
}
