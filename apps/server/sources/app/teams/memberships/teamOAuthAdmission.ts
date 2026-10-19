import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx, readTeamMutationAdmissionAccountIdsInTx } from "./sessionAccessEffects";
import { acquireAccountSessionOwnerMetadataFencesInTx, type AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";
import { readTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";
import { readOAuthAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";
import type { ProviderReference } from "@/app/auth/providers/providerReference";
import { applyExternalTeamMembershipInTx } from "./externalFacts";
import type { TeamOAuthAdmissionSource } from "./teamOAuthAdmissionSource";
import { readActiveTeamInvitationAdmissionReferenceInTx } from "../invitations/invitationLifecycle";
import { applyReadyDirectorySourceFactsForAccountInTx } from "../directory/directoryProjectionRepository";
import { isEffectiveTeamMembership } from "./effectiveMembership";
import { isTeamMembershipAdmissionEnabled } from "./membershipService";

export type TeamOAuthAdmissionResult =
    | Readonly<{ status: "qualified_existing_member" }>
    | Readonly<{ status: "admitted"; outcome: "added" | "already_member" }>
    | Readonly<{ status: "invitation_required" }>
    | Readonly<{ status: "admission_required" }>
    | Readonly<{ status: "unavailable" }>;

/**
 * Select structural admission once, after the exact OAuth identity has been linked.
 *
 * Authentication is not an invitation and an enabled connection is not a generic
 * membership capability. Provisioned membership is materialized from the exact
 * directory source and JIT membership from the exact identity connection; both
 * delegate to the sole Lane 01 membership leaf.
 */
export async function finalizeTeamOAuthAdmissionInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        connectionId: string | null;
        connectionRevision: number | null;
        providerInstanceId: string;
        accountId: string;
        source: TeamOAuthAdmissionSource | null | undefined;
    }>,
): Promise<TeamOAuthAdmissionResult> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamMembership", teamId: input.teamId } });
    const [team, connection, membership] = await Promise.all([
        tx.team.findUnique({
            where: { id: input.teamId },
            select: { admissionMode: true, archivedAt: true },
        }),
        input.connectionId
            ? readTeamIdentityConnectionInTx(tx, { id: input.connectionId, teamId: input.teamId })
            : Promise.resolve(null),
        tx.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: input.teamId, accountId: input.accountId } },
            select: {
                status: true,
                account: { select: { status: true } },
            },
        }),
    ]);
    if (!team || team.archivedAt !== null) return { status: "unavailable" };
    if (input.connectionId !== null && (connection?.status !== "ready"
        || connection.connection.state !== "connected"
        || connection.connection.revision !== input.connectionRevision
        || connection.connection.providerInstanceId !== input.providerInstanceId)) {
        return { status: "unavailable" };
    }
    if (membership && isEffectiveTeamMembership({
        membershipStatus: membership.status,
        accountStatus: membership.account.status,
        teamArchivedAt: team.archivedAt,
    })) {
        // Membership is already the Team owner's authoritative admission fact.
        // Requiring the current sign-in attempt to reproduce its historical
        // management provenance would turn authentication into a second
        // membership decision and strand valid members after policy changes.
        return { status: "qualified_existing_member" };
    }
    const source = input.source;
    if (!source
        || source.teamId !== input.teamId
        || source.providerId !== input.providerInstanceId
        || source.connectionId !== input.connectionId
        || source.connectionRevision !== input.connectionRevision
        || source.admissionMode !== team.admissionMode) {
        return { status: "admission_required" };
    }
    if (team.admissionMode === "invite_only") {
        // Authentication may complete for an existing Account, but the separate
        // invitation owner must still validate and consume the exact invitation
        // during explicit Join confirmation. No membership is written here.
        const sourceMatchesAttempt = source.kind === "team_invitation"
            && ((source.providerOrigin === "home" && input.connectionId === null)
                || (source.providerOrigin === "team" && input.connectionId !== null));
        if (!sourceMatchesAttempt) return { status: "admission_required" };
        const invitation = await readActiveTeamInvitationAdmissionReferenceInTx(tx, {
            invitationId: source.invitationId,
            teamId: input.teamId,
            tokenHash: source.tokenHash,
        });
        return invitation
            ? { status: "invitation_required" }
            : { status: "admission_required" };
    }
    if (team.admissionMode === "provisioned") {
        if (source.kind !== "team_provisioned_identity") return { status: "admission_required" };
        const [identity, providerInstance] = await Promise.all([
            tx.teamProvisionedIdentity.findUnique({
                where: { id: source.provisionedIdentityId },
                select: {
                    id: true,
                    state: true,
                    boundAccountId: true,
                    source: {
                        select: {
                            id: true,
                            teamId: true,
                            kind: true,
                            teamIdentityConnectionId: true,
                            githubAppInstallationId: true,
                        },
                    },
                },
            }),
            tx.identityProviderInstance.findUnique({
                where: { id: input.providerInstanceId },
                select: { kind: true, githubAppInstallationId: true },
            }),
        ]);
        const sourceMatchesProvider = identity?.source.kind === "workos_directory"
            ? identity.source.teamIdentityConnectionId === input.connectionId
            : identity?.source.kind === "github_organization"
                && providerInstance?.kind === "github_app_identity"
                && identity.source.githubAppInstallationId === providerInstance.githubAppInstallationId;
        if (!identity
            || identity.state !== "active"
            || identity.source.teamId !== input.teamId
            || !sourceMatchesProvider
            || identity.boundAccountId !== input.accountId) {
            return { status: "admission_required" };
        }
        const applied = await applyReadyDirectorySourceFactsForAccountInTx(tx, {
            sourceId: identity.source.id,
            teamId: input.teamId,
            accountId: input.accountId,
        });
        return applied
            ? { status: "admitted", outcome: "added" }
            : { status: "admission_required" };
    }

    const home = await readHomeGovernancePolicyInTx(tx);
    if (home.teamProviders.status !== "narrowed" || !home.teamProviders.policy.teamJitAllowed) {
        return { status: "admission_required" };
    }
    // Whether the Home still allows this provider kind is decided once, by the
    // catalog when it resolves the Team runtime; a prohibited kind never
    // reaches this branch with a live runtime.
    if (connection?.status !== "ready") return { status: "unavailable" };
    if (source.kind !== "team_jit_identity") return { status: "admission_required" };
    const admitted = await applyExternalTeamMembershipInTx(tx, {
        teamId: input.teamId,
        accountId: input.accountId,
        source: {
            kind: "identity_connection",
            teamIdentityConnectionId: input.connectionId!,
        },
        desired: "active",
        historyAccess: "from_membership",
    });
    return (admitted.status === "applied" || admitted.status === "unchanged")
        && admitted.teamMembershipId !== null
        ? { status: "admitted", outcome: admitted.status === "applied" ? "added" : "already_member" }
        : { status: "admission_required" };
}

export class TeamOAuthAdmissionAbort extends Error {
    readonly code: "team_authentication_required" | "team_authentication_unavailable";

    constructor(code: TeamOAuthAdmissionAbort["code"]) {
        super(code);
        this.name = "TeamOAuthAdmissionAbort";
        this.code = code;
    }
}

type TeamOAuthAdmissionScopeInput = Readonly<{
    provider: ProviderReference | null | undefined;
    connection: Readonly<{ id: string; revision: number }> | null | undefined;
    admission?: TeamOAuthAdmissionSource | null;
}>;

function resolveTeamOAuthAdmissionScope(input: TeamOAuthAdmissionScopeInput) {
    if (!input.provider) throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");
    const invitation = input.admission?.kind === "team_invitation" ? input.admission : null;
    const teamId = input.provider.context.kind === "team" ? input.provider.context.teamId : invitation?.teamId;
    if (!teamId
        || (input.provider.context.kind === "team" && !input.connection)
        || (input.provider.context.kind === "home" && (!invitation || invitation.providerOrigin !== "home"))) {
        throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");
    }
    return { teamId, provider: input.provider, teamConnection: input.provider.context.kind === "team" ? input.connection : null };
}

/** Pure full cohort for OAuth's identity-link/directory/JIT composition. The
 * exact provider/connection Team is shared with final admission, never guessed
 * from profile claims; prospective Accounts need not have been inserted yet. */
export async function readTeamOAuthAdmissionAccountIdsInTx(
    tx: Tx, input: TeamOAuthAdmissionScopeInput & Readonly<{ accountIds: readonly string[] }>,
): Promise<readonly string[]> {
    if (!input.provider || (input.provider.context.kind === "home" && input.admission?.kind !== "team_invitation")) {
        return [...new Set(input.accountIds)].sort();
    }
    const { teamId } = resolveTeamOAuthAdmissionScope(input);
    return await readTeamMutationAdmissionAccountIdsInTx(tx, {
        teamId, accountIds: input.accountIds, affectedAccountIds: input.accountIds,
        membershipChange: { kind: "teamMembership", teamId },
    });
}

export async function acquireTeamOAuthAdmissionAccountsInTx(
    tx: Tx, input: TeamOAuthAdmissionScopeInput & Readonly<{ accountIds: readonly string[]; intent: AccountAdmissionIntent }>,
): Promise<() => Promise<void>> {
    const accountIds = await readTeamOAuthAdmissionAccountIdsInTx(tx, input);
    await acquireAccountSessionOwnerMetadataFencesInTx(tx, accountIds, input.intent);
    const captured = new Set(accountIds);
    const recheck = async () => {
        if ((await readTeamOAuthAdmissionAccountIdsInTx(tx, input)).some(accountId => !captured.has(accountId))) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    };
    await recheck();
    return recheck;
}

/**
 * The single OAuth finalization seam: prove the exact linked identity and structural
 * admission in the caller's transaction, or throw so every earlier write rolls back.
 *
 * The returned evidence is carried by the ordinary Home credential. Whether that
 * evidence satisfies the Team's accepted-authentication policy is deliberately
 * decided only by the later protected Team operation; it is not membership authority.
 */
export async function requireTeamOAuthAdmissionInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        accountId: string;
        provider: ProviderReference | null | undefined;
        connection: Readonly<{ id: string; revision: number }> | null | undefined;
        admission?: TeamOAuthAdmissionSource | null;
    }>,
) {
    if (!await isTeamMembershipAdmissionEnabled({ tx, env: input.env })) {
        throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");
    }
    const { teamId, provider, teamConnection } = resolveTeamOAuthAdmissionScope(input);
    // Resolve the credential evidence before structural admission. For JIT this
    // binds the Account to the exact provider runtime and Team connection carried
    // from the consumed server-owned OAuth attempt; a caller-supplied Account id
    // alone can never mint a membership.
    const evidence = await readOAuthAuthenticationEvidenceInTx(tx, {
        accountId: input.accountId,
        providerId: provider.id,
        runtimeFingerprint: provider.runtimeFingerprint,
        ...(teamConnection ? { teamConnectionId: teamConnection.id } : {}),
    });
    if (!evidence) throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");

    const admission = await finalizeTeamOAuthAdmissionInTx(tx, {
        teamId,
        connectionId: teamConnection?.id ?? null,
        connectionRevision: teamConnection?.revision ?? null,
        providerInstanceId: provider.id,
        accountId: input.accountId,
        source: input.admission,
    });
    if (admission.status === "admission_required") {
        throw new TeamOAuthAdmissionAbort("team_authentication_required");
    }
    if (admission.status === "unavailable") {
        throw new TeamOAuthAdmissionAbort("team_authentication_unavailable");
    }
    const invitationRequired = admission.status === "invitation_required";
    if (invitationRequired) {
        if (input.admission?.kind !== "team_invitation") {
            throw new TeamOAuthAdmissionAbort("team_authentication_required");
        }
        // This proves only that the exact server-authored invitation continuation
        // belongs to this authentication attempt. Existing Accounts keep the
        // original bearer and must confirm Join through the invitation owner.
        // Fresh-Account provisioning consumes its bounded reference separately,
        // inside the same transaction that created the Account.
    }

    return { authenticationEvidence: evidence, invitationRequired } as const;
}
