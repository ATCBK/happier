import { managedGitHubAppUserAuthorizationCallbackUrl } from "./githubManagedAppManifest";
import type {
    TeamIdentityConnectionExternalReferenceV1,
    TeamIdentityConnectionSettingsV1,
} from "@happier-dev/protocol/teams";

import type { ProviderModule } from "@/app/auth/providers/providerModules";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { ProviderCatalogContext } from "@/app/auth/providers/providerReference";
import type { IdentityProviderInstanceView } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import type { OutboundIdentityNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderFeatures } from "@/app/auth/providers/types";

import { prepareIdentityLink, refreshIdentity, unlinkIdentity } from "@/app/auth/providers/accountIdentityLifecycle";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { prepareIdentityConnectionGroupRefresh } from "@/app/teams/memberships/identityConnectionGroupRefresh";
import {
    resolveManagedIdentityNetworkPolicy,
    resolveManagedIdentityNetworkPolicyInTx,
} from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { bindDirectoryProvisionedIdentitiesInTx, type DirectoryProvisionedIdentityMatch } from "@/app/teams/directory/provisionedIdentityBinding";

import {
    createManagedGitHubUserOAuthProvider,
    parseManagedGitHubUserProfile,
} from "./githubManagedUserOAuth";
import {
    readGitHubTeamMembershipObservation,
    verifyGitHubOrganizationMember,
} from "./githubAppInstallationClient";
import {
    decryptGitHubAppRegistrationSecretsV1,
    parseGitHubAppRegistrationConfigV1,
    parseGitHubPermissionsV1,
    resolveGitHubAppConsumerReadinessV1,
} from "./githubManagedApp";
import {
    isGitHubAppRegistrationOwnerEligible,
    isManagedGitHubHostApprovedByHome,
} from "./githubAppInstallationEligibility";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";

export type ManagedGitHubIdentityProviderModuleInput = Readonly<{
    providerId: string;
    callbackProviderId?: string;
    displayName: string;
    context: ProviderCatalogContext;
    connectionId: string | null;
    githubHost: string;
    githubAppId: bigint;
    githubClientId: string;
    clientSecret: string;
    privateKey: string;
    githubInstallationId: bigint;
    githubAppInstallationRecordId: string;
    githubOrganizationId: bigint;
    githubOrganizationLogin: string;
    redirectUrl: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

export type ResolveManagedGitHubIdentityProviderModuleResult = Readonly<{
    module: ProviderModule;
    runtimeFingerprint: string;
    connectionRevision: number | null;
}>;

export type ManagedGitHubIdentityProviderRuntimeMetadata = Readonly<{
    runtimeFingerprint: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

export type ManagedGitHubIdentityPresentation = Pick<
    IdentityProvider,
    "extractLinkedProvider" | "extractProfileBadge" | "extractSocialProfile"
>;

export function createManagedGitHubIdentityPresentation(
    githubHost: string,
): ManagedGitHubIdentityPresentation {
    const profileBaseUrl = githubHost.replace(/\/$/u, "");
    return Object.freeze({
        extractSocialProfile: ({ profile }) => {
            try {
                return { bio: null, suggestedUsername: parseManagedGitHubUserProfile(profile).login };
            } catch {
                return { bio: null, suggestedUsername: null };
            }
        },
        extractLinkedProvider: ({ profile, providerLogin }) => {
            let parsed: ReturnType<typeof parseManagedGitHubUserProfile> | null = null;
            try { parsed = parseManagedGitHubUserProfile(profile); } catch { /* unreadable stored profile */ }
            const login = parsed?.login ?? providerLogin?.trim() ?? null;
            return {
                displayName: parsed?.name?.trim() || null,
                avatarUrl: parsed?.avatar_url?.trim() || null,
                profileUrl: login ? `${profileBaseUrl}/${encodeURIComponent(login)}` : null,
            };
        },
        extractProfileBadge: ({ profile, providerLogin }) => {
            let parsed: ReturnType<typeof parseManagedGitHubUserProfile> | null = null;
            try { parsed = parseManagedGitHubUserProfile(profile); } catch { /* unreadable stored profile */ }
            const login = parsed?.login ?? providerLogin?.trim() ?? null;
            return login
                ? { label: `@${login}`, url: `${profileBaseUrl}/${encodeURIComponent(login)}` }
                : null;
        },
    });
}

/** Safe presentation lookup for an already-linked immutable managed provider id. */
export async function resolveManagedGitHubIdentityProviderPresentationInTx(
    tx: Tx,
    provider: IdentityProviderInstanceView,
): Promise<ManagedGitHubIdentityPresentation | null> {
    if (provider.kind !== "github_app_identity" || provider.githubAppInstallationId === null) return null;
    const installation = await tx.gitHubAppInstallation.findUnique({
        where: { id: provider.githubAppInstallationId },
        select: { registration: { select: { githubHost: true } } },
    });
    return installation
        ? createManagedGitHubIdentityPresentation(installation.registration.githubHost)
        : null;
}

type ManagedGitHubIdentityProviderReadiness = Readonly<{
    installationId: string;
    organizationLogin: string;
    providerSecurityRevision: number;
    registrationSecurityRevision: number;
    installationRevision: number;
    networkFingerprint: string;
    networkPolicy: OutboundIdentityNetworkPolicy;
}>;

async function resolveManagedGitHubIdentityProviderReadinessInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<ManagedGitHubIdentityProviderReadiness | null> {
    if (
        input.provider.kind !== "github_app_identity"
        || input.provider.config.kind !== "github_app_identity"
        || input.provider.githubAppInstallationId === null
        || (input.context.kind === "home" && input.provider.owner.kind !== "home")
        || (
            input.provider.owner.kind === "team"
            && (input.context.kind !== "team" || input.context.teamId !== input.provider.owner.teamId)
        )
    ) return null;
    const installation = await tx.gitHubAppInstallation.findUnique({
        where: { id: input.provider.githubAppInstallationId },
        select: {
            id: true,
            githubOrganizationLogin: true,
            revision: true,
            state: true,
            verifiedPermissions: true,
            suspendedAt: true,
            lastVerifiedAt: true,
            registration: { select: {
                ownerTeamId: true,
                githubHost: true,
                config: true,
                securityRevision: true,
                state: true,
                lastVerifiedAt: true,
            } },
        },
    });
    if (
        !installation
        || installation.state !== "verified"
        || installation.suspendedAt !== null
        || installation.lastVerifiedAt === null
        || installation.registration.state !== "verified"
        || installation.registration.lastVerifiedAt === null
        || !isGitHubAppRegistrationOwnerEligible(installation.registration.ownerTeamId, input.context)
        || !isManagedGitHubHostApprovedByHome(
            await readHomeGovernancePolicyInTx(tx),
            installation.registration.githubHost,
        )
    ) return null;
    let config: ReturnType<typeof parseGitHubAppRegistrationConfigV1>;
    let permissions: ReturnType<typeof parseGitHubPermissionsV1>;
    try {
        config = parseGitHubAppRegistrationConfigV1(installation.registration.config);
        permissions = parseGitHubPermissionsV1(installation.verifiedPermissions);
    } catch {
        return null;
    }
    if (!resolveGitHubAppConsumerReadinessV1({
        purpose: { kind: "identity", requiresOrganizationEvidence: true },
        registration: {
            state: installation.registration.state,
            secretHealth: config.secretHealth ?? {
                clientSecretConfigured: false,
                privateKeyConfigured: false,
                webhookSecretConfigured: false,
            },
        },
        installation: {
            state: installation.state,
            suspended: installation.suspendedAt !== null,
            permissions,
            events: [],
        },
    }).ok) return null;
    const network = await resolveManagedIdentityNetworkPolicyInTx(tx, {
        env: input.env,
        timeoutSeconds: 30,
    });
    return {
        installationId: installation.id,
        organizationLogin: installation.githubOrganizationLogin,
        providerSecurityRevision: input.provider.securityRevision,
        registrationSecurityRevision: installation.registration.securityRevision,
        installationRevision: installation.revision,
        networkFingerprint: network.fingerprint,
        networkPolicy: network.policy,
    };
}

export async function isManagedGitHubIdentityProviderAvailableForConnectionInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<boolean> {
    return await resolveManagedGitHubIdentityProviderReadinessInTx(tx, input) !== null;
}

/**
 * The exact connection a Team binding for this GitHub provider must carry.
 *
 * Both the eligible-provider projection an administrator is shown and the
 * create-connection path that validates what they send back read this one
 * result. Building the reference/settings pair separately in each place would
 * let the offered draft and the accepted draft drift, and the only symptom
 * would be an `identity_connection_invalid` rejection of the exact values the
 * server itself proposed.
 */
export async function resolveManagedGitHubIdentityProviderConnectionDraftInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
    }>,
): Promise<Readonly<{
    externalReference: Extract<TeamIdentityConnectionExternalReferenceV1, { kind: "github_app_identity" }>;
    settings: Extract<TeamIdentityConnectionSettingsV1, { kind: "github_app_identity" }>;
}> | null> {
    const readiness = await resolveManagedGitHubIdentityProviderReadinessInTx(tx, input);
    return readiness && {
        externalReference: {
            v: 1,
            kind: "github_app_identity",
            installationId: readiness.installationId,
        },
        settings: {
            v: 1,
            kind: "github_app_identity",
            organizationLogin: readiness.organizationLogin,
        },
    };
}

export function resolveManagedGitHubAuthProviderFeatures(
    input: Readonly<{ displayName: string; enabled: boolean; configured: boolean }>,
    policy: AuthPolicy,
): AuthProviderFeatures {
    return {
        enabled: input.enabled,
        configured: input.configured,
        ui: {
            displayName: input.displayName,
            iconHint: "github",
            connectButtonColor: "#24292F",
            supportsProfileBadge: true,
            badgeIconName: "github",
        },
        restrictions: { usersAllowlist: false, orgsAllowlist: true, orgMatch: "all" },
        offboarding: {
            enabled: policy.offboarding.enabled,
            intervalSeconds: policy.offboarding.intervalSeconds,
            mode: policy.offboarding.mode,
            source: "managed_github_app",
        },
    };
}

export async function resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
    }>,
): Promise<ManagedGitHubIdentityProviderRuntimeMetadata | null> {
    const key = "single";
    return (await resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(tx, {
        inputs: [{ key, ...input }],
    })).get(key) ?? null;
}

/** Loads current GitHub registration/installation facts once for a bounded set
 * of authentication descriptors. Each result remains bound to its caller key,
 * exact owner context, provider lifetime, and connection revision. */
export async function resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(
    tx: Tx,
    input: Readonly<{ inputs: readonly Readonly<{
        key: string;
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
    }>[] }>,
): Promise<ReadonlyMap<string, ManagedGitHubIdentityProviderRuntimeMetadata>> {
    const candidates = input.inputs.filter((candidate) =>
        candidate.provider.kind === "github_app_identity"
        && candidate.provider.config.kind === "github_app_identity"
        && candidate.provider.githubAppInstallationId !== null
        && (candidate.context.kind === "team") === (candidate.connectionId !== null)
        && (candidate.connectionId === null) === (candidate.connectionRevision === null)
        && (candidate.connectionRevision === null || candidate.connectionRevision >= 1));
    if (candidates.length === 0) return new Map();
    const [home, installations] = await Promise.all([
        readHomeGovernancePolicyInTx(tx),
        tx.gitHubAppInstallation.findMany({
            // A catalog capture must not mix installation facts with a later
            // registration snapshot. Row providers support one joined statement;
            // SQLite's enclosing write admission already excludes other writers.
            ...(getDbProviderFromEnv(process.env, "postgres") === "sqlite" ? {} : { relationLoadStrategy: "join" as const }),
            where: { id: { in: [...new Set(candidates.flatMap((candidate) =>
                candidate.provider.githubAppInstallationId ? [candidate.provider.githubAppInstallationId] : []))] } },
            select: {
                id: true,
                githubOrganizationLogin: true,
                revision: true,
                state: true,
                verifiedPermissions: true,
                suspendedAt: true,
                lastVerifiedAt: true,
                registration: { select: {
                    ownerTeamId: true,
                    githubHost: true,
                    config: true,
                    securityRevision: true,
                    state: true,
                    lastVerifiedAt: true,
                } },
            },
        }),
    ]);
    const installationById = new Map(installations.map((installation) => [installation.id, installation]));
    const results = new Map<string, ManagedGitHubIdentityProviderRuntimeMetadata>();
    for (const candidate of candidates) {
        const installationId = candidate.provider.githubAppInstallationId;
        const installation = installationId ? installationById.get(installationId) : undefined;
        if (
            !installation
            || installation.state !== "verified"
            || installation.suspendedAt !== null
            || installation.lastVerifiedAt === null
            || installation.registration.state !== "verified"
            || installation.registration.lastVerifiedAt === null
            || !isGitHubAppRegistrationOwnerEligible(installation.registration.ownerTeamId, candidate.context)
            || !isManagedGitHubHostApprovedByHome(home, installation.registration.githubHost)
        ) continue;
        let config: ReturnType<typeof parseGitHubAppRegistrationConfigV1>;
        let permissions: ReturnType<typeof parseGitHubPermissionsV1>;
        try {
            config = parseGitHubAppRegistrationConfigV1(installation.registration.config);
            permissions = parseGitHubPermissionsV1(installation.verifiedPermissions);
        } catch {
            continue;
        }
        if (!resolveGitHubAppConsumerReadinessV1({
            purpose: { kind: "identity", requiresOrganizationEvidence: true },
            registration: {
                state: installation.registration.state,
                secretHealth: config.secretHealth ?? {
                    clientSecretConfigured: false,
                    privateKeyConfigured: false,
                    webhookSecretConfigured: false,
                },
            },
            installation: {
                state: installation.state,
                suspended: installation.suspendedAt !== null,
                permissions,
                events: [],
            },
        }).ok) continue;
        const network = resolveManagedIdentityNetworkPolicy({ env: candidate.env, timeoutSeconds: 30, home });
        results.set(candidate.key, {
            runtimeFingerprint: [
                "managed-github:v1",
                candidate.provider.securityRevision,
                installation.registration.securityRevision,
                installation.revision,
                candidate.connectionRevision ?? "home",
                network.fingerprint,
            ].join(":"),
            networkPolicy: network.policy,
        });
    }
    return results;
}

export async function resolveManagedGitHubIdentityProviderModuleInTx(
    tx: Tx,
    input: Readonly<{
        env: NodeJS.ProcessEnv;
        context: ProviderCatalogContext;
        provider: IdentityProviderInstanceView;
        connectionId: string | null;
        connectionRevision: number | null;
        publicServerUrl: string;
    }>,
): Promise<ResolveManagedGitHubIdentityProviderModuleResult | null> {
    const metadata = await resolveManagedGitHubIdentityProviderRuntimeMetadataInTx(tx, input);
    const githubAppInstallationRecordId = input.provider.githubAppInstallationId;
    if (!metadata || githubAppInstallationRecordId === null) return null;
    const installation = await tx.gitHubAppInstallation.findUnique({
        where: { id: githubAppInstallationRecordId },
        select: {
            githubInstallationId: true,
            githubOrganizationId: true,
            githubOrganizationLogin: true,
            revision: true,
            state: true,
            verifiedPermissions: true,
            suspendedAt: true,
            lastVerifiedAt: true,
            registration: {
                select: {
                    id: true,
                    ownerTeamId: true,
                    githubHost: true,
                    githubAppId: true,
                    githubClientId: true,
                    config: true,
                    encryptedSecrets: true,
                    securityRevision: true,
                    state: true,
                    lastVerifiedAt: true,
                },
            },
        },
    });
    if (!installation) return null;
    let secrets: ReturnType<typeof decryptGitHubAppRegistrationSecretsV1>;
    let permissions: ReturnType<typeof parseGitHubPermissionsV1>;
    try {
        parseGitHubAppRegistrationConfigV1(installation.registration.config);
        secrets = decryptGitHubAppRegistrationSecretsV1({
            registrationId: installation.registration.id,
            encryptedSecrets: Uint8Array.from(installation.registration.encryptedSecrets),
        });
        permissions = parseGitHubPermissionsV1(installation.verifiedPermissions);
    } catch {
        return null;
    }
    if (
        !secrets.clientSecret
        || !secrets.privateKey
        || (permissions.members !== "read" && permissions.members !== "write")
    ) return null;
    return {
        module: createManagedGitHubIdentityProviderModule({
            providerId: input.provider.id,
            callbackProviderId: "github-app",
            displayName: input.provider.displayName,
            context: input.context,
            connectionId: input.connectionId,
            githubHost: installation.registration.githubHost,
            githubAppId: installation.registration.githubAppId,
            githubClientId: installation.registration.githubClientId,
            clientSecret: secrets.clientSecret,
            privateKey: secrets.privateKey,
            githubInstallationId: installation.githubInstallationId,
            githubAppInstallationRecordId,
            githubOrganizationId: installation.githubOrganizationId,
            githubOrganizationLogin: installation.githubOrganizationLogin,
            redirectUrl: managedGitHubAppUserAuthorizationCallbackUrl(input.publicServerUrl),
            networkPolicy: metadata.networkPolicy,
        }),
        runtimeFingerprint: metadata.runtimeFingerprint,
        connectionRevision: input.connectionRevision,
    };
}

/** Builds the live leaves for one verified managed GitHub identity consumer. */
export function createManagedGitHubIdentityProviderModule(
    input: ManagedGitHubIdentityProviderModuleInput,
): ProviderModule {
    const getDirectoryIdentityMatch = (profile: unknown): DirectoryProvisionedIdentityMatch | null =>
        input.context.kind === "team" ? {
            kind: "github_organization",
            githubAppInstallationId: input.githubAppInstallationRecordId,
            externalUserId: String(parseManagedGitHubUserProfile(profile).id),
        } : null;
    const identity = createManagedGitHubIdentityProvider(input, getDirectoryIdentityMatch);
    return Object.freeze({
        id: input.providerId,
        oauth: Object.freeze({
            ...createManagedGitHubUserOAuthProvider({
                providerId: input.providerId,
                callbackProviderId: input.callbackProviderId,
                githubHost: input.githubHost,
                clientId: input.githubClientId,
                clientSecret: input.clientSecret,
                redirectUrl: input.redirectUrl,
                networkPolicy: input.networkPolicy,
            }),
            getDirectoryIdentityMatch,
        }),
        identity,
        auth: Object.freeze({
            id: input.providerId,
            resolveFeatures: ({ policy }: { policy: AuthPolicy }) => resolveManagedGitHubAuthProviderFeatures({
                displayName: input.displayName,
                enabled: true,
                configured: true,
            }, policy),
            requiresOAuth: true,
            isConfigured: () => true,
        }),
    });
}

function createManagedGitHubIdentityProvider(
    input: ManagedGitHubIdentityProviderModuleInput,
    getDirectoryIdentityMatch: (profile: unknown) => DirectoryProvisionedIdentityMatch | null,
): IdentityProvider {
    const organizationMembership = (profile: ReturnType<typeof parseManagedGitHubUserProfile>) =>
        verifyGitHubOrganizationMember({
            githubHost: input.githubHost,
            githubAppId: input.githubAppId,
            privateKey: input.privateKey,
            githubInstallationId: input.githubInstallationId,
            githubOrganizationLogin: input.githubOrganizationLogin,
            githubUserId: BigInt(profile.id),
            githubUserLogin: profile.login,
            networkPolicy: input.networkPolicy,
        });

    const prepareConnect: IdentityProvider["prepareConnect"] = async (params) => {
        const profile = parseManagedGitHubUserProfile(params.profile);
        const directoryMatch = getDirectoryIdentityMatch(profile);
        const membership = await organizationMembership(profile);
        if (membership.status === "unavailable") throw new Error("github_membership_unknown");
        if (membership.status !== "active") throw new Error("github_organization_mismatch");
        const preparedGroups = input.context.kind === "team" && input.connectionId !== null
            ? await prepareIdentityConnectionGroupRefresh({
                accountId: params.ctx.uid,
                teamId: input.context.teamId,
                connectionId: input.connectionId,
                observeActiveExternalGroupIds: async (githubTeamIds) => {
                    if (githubTeamIds.length === 0) return new Set<string>();
                    const observation = await readGitHubTeamMembershipObservation({
                        githubHost: input.githubHost,
                        githubAppId: input.githubAppId,
                        privateKey: input.privateKey,
                        githubInstallationId: input.githubInstallationId,
                        githubOrganizationId: input.githubOrganizationId,
                        githubUserLogin: profile.login,
                        githubTeamIds,
                        networkPolicy: input.networkPolicy,
                    });
                    return observation.status === "complete"
                        ? new Set(observation.activeTeamIds)
                        : null;
                },
            })
            : null;
        const preparedIdentity = await prepareIdentityLink({
            accountId: params.ctx.uid,
            provider: input.providerId,
            providerUserId: String(profile.id),
            providerLogin: profile.login.toLowerCase(),
            profile,
            token: null,
            presentation: {
                username: params.preferredUsername ?? profile.login,
                name: profile.name,
            },
            eligibility: {
                eligibilityStatus: "eligible",
                eligibilityReason: null,
                eligibilityCheckedAt: new Date(),
                eligibilityNextCheckAt: null,
            },
            transferFromAccountId: params.transferFromAccountId,
            usernamePolicyEnv: params.usernamePolicyEnv,
        });
        return {
            connectInTx: async (tx) => {
                await preparedIdentity.connectInTx(tx);
                if (input.context.kind === "team" && directoryMatch) {
                    await bindDirectoryProvisionedIdentitiesInTx(tx, {
                        accountId: params.ctx.uid,
                        teamId: input.context.teamId,
                        match: directoryMatch,
                    });
                }
                await preparedGroups?.applyInTx(tx);
            },
        };
    };

    return Object.freeze({
        id: input.providerId,
        prepareConnect,
        connect: async (params) => {
            const prepared = await prepareConnect(params);
            await inTx(prepared.connectInTx, { isolationLevel: "Serializable" /* Managed GitHub identity linking composes current directory/source and provider admission. */ });
        },
        disconnect: async ({ ctx }) => await unlinkIdentity({
            accountId: ctx.uid,
            provider: input.providerId,
        }),
        enforceLoginEligibility: async ({ accountId, policy, now = new Date() }) => {
            const normalizedAccountId = accountId.trim();
            if (!normalizedAccountId) return { ok: false, statusCode: 401, error: "invalid-token" };
            const stored = await db.accountIdentity.findFirst({
                where: { accountId: normalizedAccountId, provider: input.providerId },
                select: {
                    id: true,
                    profile: true,
                    eligibilityStatus: true,
                    eligibilityCheckedAt: true,
                    eligibilityNextCheckAt: true,
                },
            });
            if (!stored) {
                return { ok: false, statusCode: 403, error: "provider-required", provider: input.providerId };
            }
            const shouldCheck = policy.offboarding.enabled
                ? !stored.eligibilityNextCheckAt || stored.eligibilityNextCheckAt <= now
                : stored.eligibilityCheckedAt === null;
            if (!shouldCheck) {
                if (stored.eligibilityStatus === "eligible") return { ok: true };
                if (stored.eligibilityStatus === "ineligible") {
                    return { ok: false, statusCode: 403, error: "not-eligible" };
                }
                return { ok: false, statusCode: 503, error: "upstream_error" };
            }
            let profile: ReturnType<typeof parseManagedGitHubUserProfile>;
            try {
                profile = parseManagedGitHubUserProfile(stored.profile);
            } catch {
                return { ok: false, statusCode: 403, error: "not-eligible" };
            }
            const checked = await organizationMembership(profile);
            const nextCheckAt = policy.offboarding.enabled
                ? new Date(now.getTime() + policy.offboarding.intervalSeconds * 1000)
                : null;
            await refreshIdentity({
                accountId: normalizedAccountId,
                provider: input.providerId,
                identityId: stored.id,
                data: {
                    eligibilityStatus: checked.status === "active"
                        ? "eligible"
                        : checked.status === "unavailable" ? "unknown" : "ineligible",
                    eligibilityReason: checked.status === "active" ? null : checked.status,
                    eligibilityCheckedAt: now,
                    eligibilityNextCheckAt: nextCheckAt,
                },
            });
            if (checked.status === "active") return { ok: true };
            if (checked.status === "unavailable") return { ok: false, statusCode: 503, error: "upstream_error" };
            return { ok: false, statusCode: 403, error: "not-eligible" };
        },
        ...createManagedGitHubIdentityPresentation(input.githubHost),
    });
}
