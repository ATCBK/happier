import type { LinkedIdentityManagementV1 } from '@happier-dev/protocol/account/profile';

import {
    buildAccountLoginViabilityFactsAfterProviderRemoval,
    checkAccountRetainsLoginRouteForDecisions,
    resolveAvailableAccountAuthenticationMethodIdsForDecisions,
} from "@/app/auth/methods/effectiveAccountLoginMethods";
import {
    isAccountIdentityEligibleForGenericPresentation,
    resolveAuthMethodIdForAccountIdentityProvider,
} from "@/app/auth/methods/registry";
import { captureHomeAuthenticationAvailabilityInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import {
    readIdentityProviderInstancePresentationsByIdsInTx,
    type IdentityProviderInstanceView,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import type { Tx } from "@/storage/inTx";
import { listTeamIdentityConnectionsInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";

function normalizeProviderId(value: string): string {
    return value.trim().toLowerCase();
}

function managedIconHint(instance: IdentityProviderInstanceView): string | null {
    if (instance.kind === "oidc" && instance.config.kind === "oidc") return instance.config.ui.iconHint;
    return instance.kind === "github_app_identity" ? "github" : null;
}

/**
 * Builds the current, viewer-authorized management sibling for Account linked identities.
 * Every policy and login decision is read in the caller's transaction; this projection is also
 * recomputed by mutations and is never treated as a reusable authorization result.
 */
export async function buildLinkedIdentityManagementProjectionInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; env: NodeJS.ProcessEnv }>,
): Promise<readonly LinkedIdentityManagementV1[]> {
    const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: {
            status: true,
            publicKey: true,
            encryptionMode: true,
            AccountPasswordCredential: { select: { accountId: true } },
            AccountIdentity: {
                orderBy: { provider: "asc" },
                select: { provider: true, eligibilityStatus: true },
            },
        },
    });
    if (!account) return [];

    const allIdentities = account.AccountIdentity.map((identity) => ({
        ...identity,
        provider: normalizeProviderId(identity.provider),
    })).filter((identity) => identity.provider.length > 0);
    const identities = allIdentities.filter((identity) =>
        isAccountIdentityEligibleForGenericPresentation(input.env, identity.provider));
    if (identities.length === 0) return [];

    const memberships = await tx.teamMembership.findMany({
        where: { accountId: input.accountId, status: "active" },
        select: {
            team: { select: { id: true, name: true, authenticationPolicy: true } },
        },
        orderBy: { teamId: "asc" },
    });
    const teamPresentations = new Map(memberships.map(({ team }) => [team.id, { id: team.id, name: team.name }]));
    const [managed, homeAvailability, connectionLists] = await Promise.all([
        readIdentityProviderInstancePresentationsByIdsInTx(tx, { ids: identities.map(({ provider }) => provider) }),
        captureHomeAuthenticationAvailabilityInTx(tx, { env: input.env }),
        Promise.all(memberships.map(({ team }) => listTeamIdentityConnectionsInTx(tx, { teamId: team.id }))),
    ]);
    const effectiveHome = homeAvailability.effectiveHome;
    const descriptors = effectiveHome.status === "ready" ? homeAvailability.providerDescriptors
        : await listProviderDescriptorsInTx(tx, input.env);
    const descriptorById = new Map(descriptors.map((entry) => [normalizeProviderId(entry.reference.id), entry]));
    const effectiveDecisions = effectiveHome.status === "ready" ? effectiveHome.decisions : null;
    const authMethodIdByIdentityProvider = new Map(allIdentities.map(({ provider }) => [
        provider,
        resolveAuthMethodIdForAccountIdentityProvider(input.env, provider) ?? provider,
    ]));
    const accountFactSource = {
        status: account.status,
        publicKey: account.publicKey,
        encryptionMode: account.encryptionMode,
        hasPasswordCredential: account.AccountPasswordCredential !== null,
        identities: allIdentities,
    };
    const accountAuthenticationFactsWithout = (excludedProviderId: string | null) =>
        buildAccountLoginViabilityFactsAfterProviderRemoval(accountFactSource, {
            env: input.env,
            excludedProviderId,
            // Team policy asks whether the retained identity can establish future evidence.
            // Upstream eligibility may recover without creating a new identity lifetime.
            identityEligibility: "identity_presence",
        });
    const currentAuthenticationMethodIds = effectiveDecisions === null
        ? null
        : new Set(resolveAvailableAccountAuthenticationMethodIdsForDecisions(
            effectiveDecisions,
            accountAuthenticationFactsWithout(null),
        ));
    const teamContexts = memberships.map(({ team }, index) => ({
        team,
        connections: connectionLists[index] ?? [],
    }));
    const usableConnectionIdsWithout = (
        connections: (typeof teamContexts)[number]["connections"],
        excludedProviderId: string | null,
    ) => connections
        .filter((connection) => allIdentities.some(({ provider }) =>
            provider !== excludedProviderId && provider === connection.providerInstanceId))
        .map((connection) => connection.id);
    const currentTeamPolicies = currentAuthenticationMethodIds === null
        ? null
        : await Promise.all(teamContexts.map(({ team, connections }) =>
            resolveTeamAuthenticationPolicyInTx(tx, {
                env: input.env,
                teamId: team.id,
                policy: team.authenticationPolicy,
                homeAvailability,
                accountFacts: {
                    usableHomeMethodIds: [...currentAuthenticationMethodIds],
                    usableTeamConnectionIds: usableConnectionIdsWithout(connections, null),
                },
            })));

    return await Promise.all(identities.map(async (identity): Promise<LinkedIdentityManagementV1> => {
        const managedRead = managed.get(identity.provider);
        const instance = managedRead?.status === "ready" ? managedRead.instance : null;
        const descriptor = descriptorById.get(identity.provider);
        const authMethodId = authMethodIdByIdentityProvider.get(identity.provider) ?? identity.provider;
        const nativeAuthMethodId = resolveAuthMethodIdForAccountIdentityProvider(input.env, identity.provider);
        const nativeDecision = nativeAuthMethodId === null
            ? null
            : effectiveDecisions?.find((decision) => decision.id === nativeAuthMethodId) ?? null;
        const managementUnreadable = managedRead?.status === "unreadable";
        let teamPolicyUnreadable = false;
        const postRemovalAuthenticationMethodIds = effectiveDecisions === null
            ? null
            : new Set(resolveAvailableAccountAuthenticationMethodIdsForDecisions(
                effectiveDecisions,
                accountAuthenticationFactsWithout(identity.provider),
            ));
        const requiredByTeams = (await Promise.all(teamContexts.map(async ({ team, connections }, index) => {
            const current = currentTeamPolicies?.[index]?.resolution;
            if (!current || postRemovalAuthenticationMethodIds === null) return [];
            const afterRemoval = (await resolveTeamAuthenticationPolicyInTx(tx, {
                env: input.env,
                teamId: team.id,
                policy: team.authenticationPolicy,
                homeAvailability,
                accountFacts: {
                    usableHomeMethodIds: [...postRemovalAuthenticationMethodIds],
                    usableTeamConnectionIds: usableConnectionIdsWithout(connections, identity.provider),
                },
            })).resolution;
            if (current.status === "unavailable" || afterRemoval.status === "unavailable") {
                teamPolicyUnreadable = true;
                return [];
            }
            if (current.status !== "restricted" || afterRemoval.status !== "restricted") return [];
            const currentlyUsable = current.choices.some((choice) => choice.availability === "usable");
            const usableAfterRemoval = afterRemoval.choices.some((choice) => choice.availability === "usable");
            const presentation = teamPresentations.get(team.id);
            return currentlyUsable && !usableAfterRemoval && presentation ? [presentation] : [];
        }))).flat();
        const uniqueRequiredTeams = [...new Map(requiredByTeams.map((team) => [team.id, team])).values()]
            .sort((left, right) => left.id.localeCompare(right.id));

        const currentProvidesLogin = effectiveDecisions?.some((decision) =>
            normalizeProviderId(decision.id) === authMethodId
            && decision.actions.some((action) => action.id === "login" && action.enabled)) === true
            && identity.eligibilityStatus !== "ineligible";
        let disconnectReason: LinkedIdentityManagementV1["disconnectReason"] = null;
        if (managementUnreadable || teamPolicyUnreadable || effectiveDecisions === null) {
            disconnectReason = "management_unavailable";
        } else if (uniqueRequiredTeams.length > 0) {
            disconnectReason = "required_by_team";
        } else if (currentProvidesLogin) {
            const verdict = checkAccountRetainsLoginRouteForDecisions(effectiveDecisions, {
                encryptionMode: account.encryptionMode === "plain" ? "plain" : "e2ee",
                accountActive: account.status === "active",
                hasPasswordCredential: account.AccountPasswordCredential !== null,
                hasNativeEmailIdentity: allIdentities.some(({ provider }) =>
                    provider !== identity.provider
                    && authMethodIdByIdentityProvider.get(provider) === "email_password"),
                providerIdentities: allIdentities
                    .filter(({ provider }) =>
                        provider !== identity.provider
                        && authMethodIdByIdentityProvider.get(provider) !== "email_password")
                    .map(({ provider, eligibilityStatus }) => ({
                        providerId: authMethodIdByIdentityProvider.get(provider) ?? provider,
                        blocked: eligibilityStatus === "ineligible",
                    })),
                hasKeyChallengeCapableCredential: account.publicKey !== null,
                isLastHomeAdministrator: false,
            });
            if (!verdict.ok) disconnectReason = "last_login_method";
        }

        const source = instance
            ? "managed"
            : descriptor?.reference.source ?? (nativeAuthMethodId === null ? "unavailable" : "built_in");
        const managedBy = !instance ? null
            : instance.owner.kind === "home" ? { kind: "home" as const }
                : teamPresentations.has(instance.owner.teamId)
                    ? { kind: "team" as const, team: teamPresentations.get(instance.owner.teamId)! }
                    : null;
        const publicationReason = managementUnreadable ? "management_unavailable" as const : null;
        return {
            v: 1,
            providerId: identity.provider,
            descriptor: {
                displayName: instance?.displayName
                    ?? descriptor?.descriptor.ui?.displayName
                    ?? nativeDecision?.ui?.displayName
                    ?? null,
                iconHint: instance
                    ? managedIconHint(instance)
                    : descriptor?.descriptor.ui?.iconHint ?? nativeDecision?.ui?.iconHint ?? null,
                source,
            },
            managedBy,
            requiredByTeams: uniqueRequiredTeams,
            canDisconnect: disconnectReason === null,
            disconnectReason,
            canPublishProfile: publicationReason === null,
            publishProfileReason: publicationReason,
        };
    }));
}
