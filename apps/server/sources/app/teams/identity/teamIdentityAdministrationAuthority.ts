import type { TeamIdentityErrorCodeV1 } from "@happier-dev/protocol/teams";

import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx, readTeamMutationAdmissionAccountIdsInTx } from "../memberships/sessionAccessEffects";
import { readExternalSourceAccountIdsInTx } from "../memberships/externalFacts";
import { acquireIdentityProviderMutationAdmissionInTx } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { HOME_PROVIDER_CONTEXT, type ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import {
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "../actorContext";

export type TeamIdentityAdministrationAuthorityError = Extract<TeamIdentityErrorCodeV1,
    | "team_not_found"
    | "team_forbidden"
    | "team_authentication_required"
    | "team_authentication_unavailable"
    | "home_forbidden"
>;

/** The same provider-instance namespace carries Home and exact Team bindings. */
export function identityConnectionOwner(teamId: string | null): ProviderCatalogContext {
    return teamId === null ? HOME_PROVIDER_CONTEXT : { kind: "team", teamId };
}

/** Resolve the complete connection/provider effect scope before an outer writer
 * takes any actor, Team, or provider lock. Direct lifecycle writers share it. */
export async function acquireTeamIdentityConnectionMutationAdmissionInTx(
    tx: Tx,
    input: Readonly<{ teamId: string | null; connectionId?: string; providerInstanceId?: string; actorAccountId?: string }>,
): Promise<() => Promise<void>> {
    const connection = input.connectionId ? await tx.teamIdentityConnection.findFirst({
        where: { id: input.connectionId, teamId: input.teamId }, select: { providerInstanceId: true },
    }) : null;
    const providerId = input.providerInstanceId ?? connection?.providerInstanceId;
    const provider = providerId ? await tx.identityProviderInstance.findUnique({
        where: { id: providerId }, select: { ownerTeamId: true },
    }) : null;
    const readAdditional = async () => {
        const sourceAccounts = input.connectionId ? await readExternalSourceAccountIdsInTx(tx, {
            owner: { kind: "identity_connection", teamIdentityConnectionId: input.connectionId },
        }) : [];
        const accountIds = [...sourceAccounts, ...(input.actorAccountId ? [input.actorAccountId] : [])];
        return input.teamId === null ? accountIds : await readTeamMutationAdmissionAccountIdsInTx(tx, {
            teamId: input.teamId, accountIds,
            membershipChange: { kind: "teamMembership", teamId: input.teamId },
        });
    };
    const additionalAccountIds = await readAdditional();
    const recheckProvider = await acquireIdentityProviderMutationAdmissionInTx(tx, {
        owner: provider ? identityConnectionOwner(provider.ownerTeamId) : identityConnectionOwner(input.teamId),
        ...(providerId ? { id: providerId } : {}), additionalAccountIds,
        additionalTeamIds: input.teamId === null ? [] : [input.teamId],
    });
    const captured = new Set(additionalAccountIds);
    const recheck = async () => {
        await recheckProvider();
        if ((await readAdditional()).some(accountId => !captured.has(accountId))) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    };
    await recheck();
    return recheck;
}

/** Identity connection writers may invoke the provider lifecycle, so enter its
 * strongest complete cohort before the generic Team/Home authority lookup. */
export async function authorizeTeamIdentityConnectionAdministrationInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<string | null> & Readonly<{ connectionId?: string; providerInstanceId?: string }>,
    operation: "view" | "mutate" = "mutate",
): Promise<TeamIdentityAdministrationAuthorityResult<TeamIdentityAdministrationAuthorityError>> {
    if (operation === "mutate") await acquireTeamIdentityConnectionMutationAdmissionInTx(tx, input);
    return await authorizeTeamIdentityAdministrationInTx(tx, input, operation);
}

type TeamIdentityAdministrationAuthorityInput<TeamId extends string | null> = Partial<TeamOperationAuthenticationContext> & Readonly<{
    teamId: TeamId;
    actorAccountId: string;
}>;
type TeamIdentityAdministrationAuthorityResult<ErrorCode extends TeamIdentityAdministrationAuthorityError> =
    Readonly<{ ok: true; canMutate: boolean }> | Readonly<{ ok: false; error: ErrorCode }>;

export function authorizeTeamIdentityAdministrationInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<string>,
    operation?: "view" | "mutate",
): Promise<TeamIdentityAdministrationAuthorityResult<Exclude<TeamIdentityAdministrationAuthorityError, "home_forbidden">>>;
export function authorizeTeamIdentityAdministrationInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<null>,
    operation?: "view" | "mutate",
): Promise<TeamIdentityAdministrationAuthorityResult<"home_forbidden">>;
export function authorizeTeamIdentityAdministrationInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<string | null>,
    operation?: "view" | "mutate",
): Promise<TeamIdentityAdministrationAuthorityResult<TeamIdentityAdministrationAuthorityError>>;
export async function authorizeTeamIdentityAdministrationInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<string | null>,
    operation: "view" | "mutate" = "mutate",
): Promise<TeamIdentityAdministrationAuthorityResult<TeamIdentityAdministrationAuthorityError>> {
    if (operation === "mutate" && input.teamId !== null) {
        await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId], membershipChange: { kind: "teamMembership", teamId: input.teamId } });
    }
    if (input.teamId === null) {
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: input.actorAccountId,
            request: { operation: operation === "view" ? "view" : "set_authentication_policy" },
        });
        return authorization.status === "authorized"
            ? { ok: true, canMutate: authorization.authority.manageAuthentication }
            : { ok: false, error: "home_forbidden" };
    }
    return await authorizeTeamIdentityAdministrationForTeamInTx(tx, { ...input, teamId: input.teamId });
}

async function authorizeTeamIdentityAdministrationForTeamInTx(
    tx: Tx,
    input: TeamIdentityAdministrationAuthorityInput<string>,
): Promise<TeamIdentityAdministrationAuthorityResult<Exclude<TeamIdentityAdministrationAuthorityError, "home_forbidden">>> {
    const actor = await resolveTeamActorContextInTx(tx, input);
    // Identity and directory administration are Team-only surfaces. Home's
    // manageAllTeams projection deliberately grants detail/metadata/lifecycle
    // authority, but must not reveal these surfaces to a non-member.
    if (!actor || !actor.teamCapabilities.viewTeam) return { ok: false, error: "team_not_found" };
    if (!actor.teamCapabilities.manageAuthentication) return { ok: false, error: "team_forbidden" };

    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: actor,
        ...input,
    });
    return qualification.ok ? { ok: true, canMutate: true } : qualification;
}
