import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { resolveTeamInvitationFreshAccountAdmissionReferenceInTx } from "@/app/teams/invitations/freshAccountAdmission";
import type { TeamOAuthAdmissionSource } from "@/app/teams/memberships/teamOAuthAdmissionSource";

/**
 * The admission authority a Team OAuth start may seed into its attempt.
 *
 * `authAttemptId` is minted by the state-attempt owner, so a JIT seed carries
 * everything but that field until `createExternalAuthorizeAttempt` stamps it.
 */
export type TeamOAuthAdmissionSeed =
    | Extract<TeamOAuthAdmissionSource, { kind: "team_invitation" }>
    | Omit<Extract<TeamOAuthAdmissionSource, { kind: "team_jit_identity" }>, "authAttemptId">
    | null;

export type TeamAdmissionStartBinding = Readonly<{
    /** Present only for a Team-owned identity connection; a Home-owned method has none. */
    connection: Readonly<{ id: string; revision: number }> | null;
    admission: TeamOAuthAdmissionSeed;
}>;

/**
 * The one Team-admission binding both OAuth starts consume.
 *
 * The unauthenticated provisioning start (`/v1/auth/external/:provider/params`)
 * and the authenticated connect start (`/v1/connect/external/:provider/params`)
 * reach the same Team through the same evidence, so the connection lookup, the
 * invitation claim and the JIT seed are decided exactly once here rather than
 * cloned per route. Structural admission is still re-decided during
 * finalization; this only records which authority the member presented.
 */
export async function resolveTeamAdmissionStartBinding(input: Readonly<{
    teamId: string;
    providerId: string;
    origin: "home" | "team";
    /** Optional narrowing to one exact connection of a Team-origin provider. */
    connectionId?: string;
    invitationToken?: string;
}>): Promise<TeamAdmissionStartBinding | null> {
    const teamId = input.teamId.trim();
    const providerId = input.providerId;
    const connectionId = String(input.connectionId ?? "").trim();
    const invitationToken = String(input.invitationToken ?? "").trim();
    if (!teamId) return null;

    if (input.origin === "team") {
        const connection = await db.teamIdentityConnection.findFirst({
            where: {
                teamId,
                providerInstanceId: providerId,
                ...(connectionId ? { id: connectionId } : {}),
            },
            select: {
                id: true,
                teamId: true,
                providerInstanceId: true,
                revision: true,
                enabled: true,
                team: { select: { admissionMode: true, archivedAt: true } },
            },
        });
        if (!connection || !connection.enabled || !connection.team || connection.team.archivedAt !== null) return null;
        if (invitationToken) {
            const invitation = await inTx((tx) => resolveTeamInvitationFreshAccountAdmissionReferenceInTx(tx, {
                token: invitationToken,
            }));
            if (!invitation || invitation.teamId !== teamId) return null;
            if (connection.team.admissionMode !== "invite_only") return null;
            return {
                connection: { id: connection.id, revision: connection.revision },
                admission: {
                    kind: "team_invitation",
                    teamId,
                    providerId,
                    providerOrigin: "team",
                    connectionId: connection.id,
                    connectionRevision: connection.revision,
                    admissionMode: "invite_only",
                    invitationId: invitation.invitationId,
                    tokenHash: invitation.tokenHash,
                },
            };
        }
        if (connection.team.admissionMode === "jit") {
            return {
                connection: { id: connection.id, revision: connection.revision },
                admission: {
                    kind: "team_jit_identity",
                    teamId,
                    providerId,
                    connectionId: connection.id,
                    connectionRevision: connection.revision,
                    admissionMode: "jit",
                },
            };
        }
        return { connection: { id: connection.id, revision: connection.revision }, admission: null };
    }

    const admission = invitationToken ? await inTx(async (tx) => {
        const [invitation, team] = await Promise.all([
            resolveTeamInvitationFreshAccountAdmissionReferenceInTx(tx, { token: invitationToken }),
            tx.team.findUnique({ where: { id: teamId }, select: { admissionMode: true } }),
        ]);
        return invitation
            && invitation.teamId === teamId
            && team?.admissionMode === "invite_only"
            ? invitation
            : null;
    }) : null;
    if (!admission) return null;
    return {
        connection: null,
        admission: {
            kind: "team_invitation",
            teamId,
            providerId,
            providerOrigin: "home",
            connectionId: null,
            connectionRevision: null,
            admissionMode: "invite_only",
            invitationId: admission.invitationId,
            tokenHash: admission.tokenHash,
        },
    };
}
