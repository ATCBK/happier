import { z } from "zod/mini";
import { TeamInvitationPostAuthContinuationV1Schema, type TeamInvitationAcceptResultV1, type TeamInvitationPostAuthContinuationV1 } from '@happier-dev/protocol/teams/invitation';

import type { Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { acceptTeamInvitationAdmissionReferenceInTx } from "./accept";

const TEAM_INVITATION_POST_AUTH_REFERENCE_PREFIX = "team_invitation_post_auth_";

const storedPostAuthContinuationSchema = z.strictObject({
    v: z.literal(1),
    kind: z.literal("team_invitation_post_auth"),
    accountId: z.string().check(z.trim(), z.minLength(1)),
    teamId: z.string().check(z.trim(), z.minLength(1)),
    invitationId: z.string().check(z.trim(), z.minLength(1)),
    tokenHash: z.string().check(z.regex(/^[0-9a-f]{64}$/u)),
});

export type ClaimedTeamInvitationPostAuthContinuation = Readonly<{
    continuation: TeamInvitationPostAuthContinuationV1;
    storedValue: string;
}>;

/**
 * Exchange an authenticated invitation preview for opaque, Account-bound custody.
 *
 * The invitation owner has already established that the invitation is active in the
 * caller's transaction. Only its digest-addressed identity crosses into RepeatKey;
 * the raw bearer never does. The continuation cannot outlive the invitation whose
 * eventual acceptance it authorizes.
 */
export async function createTeamInvitationPostAuthContinuationInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        teamId: string;
        invitationId: string;
        tokenHash: string;
        expiresAt: Date;
    }>,
): Promise<TeamInvitationPostAuthContinuationV1> {
    await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
    const storedValue = JSON.stringify(storedPostAuthContinuationSchema.parse({
        v: 1,
        kind: "team_invitation_post_auth",
        accountId: input.accountId,
        teamId: input.teamId,
        invitationId: input.invitationId,
        tokenHash: input.tokenHash,
    }));

    const reference = `${TEAM_INVITATION_POST_AUTH_REFERENCE_PREFIX}${randomKeyNaked(32)}`;
    await tx.repeatKey.create({
        data: {
            key: reference,
            value: storedValue,
            expiresAt: input.expiresAt,
        },
    });
    return TeamInvitationPostAuthContinuationV1Schema.parse({
        v: 1,
        kind: "post_auth_invitation",
        reference,
        teamId: input.teamId,
    });
}

/**
 * Turn the exact provider pending row into the explicit-Join authority in place.
 *
 * The key, expiry, and store are unchanged. The compare-and-set is the finalizer's
 * one-time claim; rollback restores the original pending row when any later
 * authentication or identity effect fails.
 */
export async function claimTeamInvitationPostAuthContinuationInTx(
    tx: Tx,
    input: Readonly<{
        reference: string;
        expectedValue: string;
        accountId: string;
        invitation: Readonly<{ teamId: string; invitationId: string; tokenHash: string }>;
    }>,
): Promise<ClaimedTeamInvitationPostAuthContinuation | null> {
    await acquireAccountChangePublicationLocksInTx(tx, [input.accountId], { includeSingleAccount: true });
    const continuation = TeamInvitationPostAuthContinuationV1Schema.parse({
        v: 1,
        kind: "post_auth_invitation",
        reference: input.reference,
        teamId: input.invitation.teamId,
    });
    const storedValue = JSON.stringify({
        v: 1,
        kind: "team_invitation_post_auth",
        accountId: input.accountId,
        teamId: input.invitation.teamId,
        invitationId: input.invitation.invitationId,
        tokenHash: input.invitation.tokenHash,
    });
    const now = await readTransactionDatabaseTime(tx);
    const claimed = await tx.repeatKey.updateMany({
        where: {
            key: input.reference,
            value: input.expectedValue,
            expiresAt: { gt: now },
        },
        data: { value: storedValue },
    });
    return claimed.count === 1 ? { continuation, storedValue } : null;
}

export async function discardClaimedTeamInvitationPostAuthContinuationInTx(
    tx: Tx,
    claimed: ClaimedTeamInvitationPostAuthContinuation,
): Promise<boolean> {
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key: claimed.continuation.reference,
            value: claimed.storedValue,
        },
    });
    return deleted.count === 1;
}

/** Read opaque custody only for its exact Account, without consuming it. */
export async function readTeamInvitationPostAuthContinuationInTx(
    tx: Tx,
    input: Readonly<{
        continuation: TeamInvitationPostAuthContinuationV1;
        accountId: string;
    }>,
): Promise<Readonly<{
    stored: z.infer<typeof storedPostAuthContinuationSchema>;
    value: string;
    now: Date;
}> | null> {
    const now = await readTransactionDatabaseTime(tx);
    const row = await tx.repeatKey.findUnique({
        where: {
            key: input.continuation.reference,
            expiresAt: { gt: now },
        },
        select: { value: true, expiresAt: true },
    });
    if (!row) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return null;
    }
    const stored = storedPostAuthContinuationSchema.safeParse(decoded);
    if (!stored.success
        || stored.data.accountId !== input.accountId
        || stored.data.teamId !== input.continuation.teamId) {
        return null;
    }
    return { stored: stored.data, value: row.value, now };
}

/** Consume the finalizer's same-row continuation through the invitation owner. */
export async function acceptTeamInvitationPostAuthContinuationInTx(
    tx: Tx,
    input: Readonly<{
        continuation: TeamInvitationPostAuthContinuationV1;
        accountId: string;
    }>,
): Promise<TeamInvitationAcceptResultV1> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.continuation.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamMembership", teamId: input.continuation.teamId } });
    const row = await readTeamInvitationPostAuthContinuationInTx(tx, input);
    if (!row) return { outcome: "not_found" };
    const consumed = await tx.repeatKey.deleteMany({
        where: {
            key: input.continuation.reference,
            value: row.value,
            expiresAt: { gt: row.now },
        },
    });
    if (consumed.count !== 1) return { outcome: "not_found" };
    return await acceptTeamInvitationAdmissionReferenceInTx(tx, {
        invitationId: row.stored.invitationId,
        tokenHash: row.stored.tokenHash,
        accountId: input.accountId,
    });
}
