import type { ManagedIdentityProviderKindV1 } from '@happier-dev/protocol/home/governance';

import {
    readHomeGovernancePolicyInTx,
    resolveTeamProviderKindPolicy,
} from "@/app/home/governance/governancePolicy";
import type { Tx } from "@/storage/inTx";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import {
    resolveTeamWorkosConnectionRuntimeInTx,
    resolveTeamWorkosProviderInstanceInTx,
} from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import {
    resolveManagedIdentityNetworkPolicyInTx,
} from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { resolveStoredGitHubDirectoryReadiness } from "@/app/integrations/github/githubManagedDirectory";
import type { ManagedGitHubDirectoryReadContext } from "@/app/integrations/github/githubManagedDirectory";

import { parseTeamDirectoryBindingConfigV1, type TeamDirectoryBindingConfigV1 } from "./directorySourceBinding";

export type DirectorySourceCompletedEvidence = Readonly<{
    id: string;
    kind: TeamDirectoryBindingConfigV1["kind"];
    state: "initializing" | "active" | "paused" | "needs_attention";
    activeReconcileRunId: string | null;
}>;

export type ExpectedDirectorySourceCurrentness =
    | Readonly<{
        kind: "github_directory_read";
        directorySourceId: ManagedGitHubDirectoryReadContext["directorySourceId"];
        githubInstallationId: ManagedGitHubDirectoryReadContext["githubInstallationId"];
        registrationSecurityRevision: ManagedGitHubDirectoryReadContext["registrationSecurityRevision"];
        installationRevision: ManagedGitHubDirectoryReadContext["installationRevision"];
        networkPolicyFingerprint: ManagedGitHubDirectoryReadContext["networkPolicyFingerprint"];
        githubOrganizationId: ManagedGitHubDirectoryReadContext["githubOrganizationId"];
        organizationLogin: ManagedGitHubDirectoryReadContext["organizationLogin"];
    }>
    | Readonly<{
        kind: "workos_directory_read";
        directorySourceId: string;
        teamIdentityConnectionId: string;
        workosDirectoryId: string;
        organizationId: string;
        runtimeFingerprint: string;
    }>;

/**
 * The sole structural readiness predicate for directory projection evidence.
 *
 * A run token means the visible rows belong to an incomplete observation even
 * when the source previously had a successful projection. A failed attempt is
 * kept non-active by the reconciliation owner, so clearing a token alone can
 * never make its partial rows authoritative.
 */
export function isDirectorySourceProjectionComplete(
    source: Pick<DirectorySourceCompletedEvidence, "state" | "activeReconcileRunId">,
): boolean {
    return source.state === "active" && source.activeReconcileRunId === null;
}

/** One canonical directory-source to identity-provider policy mapping. */
export function resolveDirectorySourceProviderKind(
    kind: TeamDirectoryBindingConfigV1["kind"],
): ManagedIdentityProviderKindV1 {
    return kind === "workos_directory" ? "workos_sso" : "github_app_identity";
}

export async function isDirectorySourceKindAllowedInTx(
    tx: Tx,
    kind: TeamDirectoryBindingConfigV1["kind"],
): Promise<boolean> {
    if (!await isServerFeatureEnabledForHome("teams", { tx })) return false;
    const policy = await readHomeGovernancePolicyInTx(tx);
    const providerKind = resolveDirectorySourceProviderKind(kind);
    return resolveTeamProviderKindPolicy(policy, providerKind) === "allowed";
}

/**
 * Recheck provider authority in the transaction that consumes observed facts.
 * A network read may have begun before its provider was disabled. Team SSO
 * enablement remains independent: only the current provider owner is checked.
 */
export async function isDirectorySourceAllowedInTx(
    tx: Tx,
    source: Pick<DirectorySourceCompletedEvidence, "id" | "kind">,
    expectedCurrentness?: ExpectedDirectorySourceCurrentness,
    env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
    if (!await isDirectorySourceKindAllowedInTx(tx, source.kind)) return false;
    if (expectedCurrentness && (
        expectedCurrentness.directorySourceId !== source.id
        || (source.kind === "github_organization") !== (expectedCurrentness.kind === "github_directory_read")
    )) return false;
    if (source.kind === "github_organization") {
        const current = await tx.teamDirectorySource.findUnique({
            where: { id: source.id },
            select: {
                kind: true,
                teamId: true,
                githubAppInstallation: {
                    select: {
                        id: true,
                        githubInstallationId: true,
                        githubOrganizationId: true,
                        githubOrganizationLogin: true,
                        revision: true,
                        state: true,
                        suspendedAt: true,
                        verifiedPermissions: true,
                        registration: {
                            select: {
                                id: true,
                                ownerTeamId: true,
                                state: true,
                                githubHost: true,
                                config: true,
                                encryptedSecrets: true,
                                securityRevision: true,
                            },
                        },
                    },
                },
            },
        });
        const installation = current?.githubAppInstallation;
        if (!current || current.kind !== source.kind || !installation) return false;
        if (expectedCurrentness?.kind === "github_directory_read") {
            if (expectedCurrentness.directorySourceId !== source.id) return false;
            if (
                installation.githubInstallationId !== expectedCurrentness.githubInstallationId
                || installation.githubOrganizationId !== expectedCurrentness.githubOrganizationId
                || installation.revision !== expectedCurrentness.installationRevision
                || installation.registration.securityRevision !== expectedCurrentness.registrationSecurityRevision
                || installation.githubOrganizationLogin !== expectedCurrentness.organizationLogin
            ) return false;
            const network = await resolveManagedIdentityNetworkPolicyInTx(tx, {
                env: process.env,
                timeoutSeconds: 30,
            });
            if (network.fingerprint !== expectedCurrentness.networkPolicyFingerprint) return false;
        }
        return resolveStoredGitHubDirectoryReadiness({
            teamId: current.teamId,
            home: await readHomeGovernancePolicyInTx(tx),
            installation: {
                state: installation.state,
                suspendedAt: installation.suspendedAt,
                verifiedPermissions: installation.verifiedPermissions,
                registration: {
                    id: installation.registration.id,
                    ownerTeamId: installation.registration.ownerTeamId,
                    state: installation.registration.state,
                    githubHost: installation.registration.githubHost,
                    config: installation.registration.config,
                    encryptedSecrets: Uint8Array.from(installation.registration.encryptedSecrets),
                },
            },
        }).ok;
    }
    if (source.kind !== "workos_directory") return true;
    const current = await tx.teamDirectorySource.findUnique({
        where: { id: source.id },
        select: { kind: true, teamId: true, teamIdentityConnectionId: true, bindingConfig: true },
    });
    if (!current || current.kind !== source.kind || !current.teamIdentityConnectionId) return false;
    if (expectedCurrentness?.kind === "workos_directory_read") {
        let binding: TeamDirectoryBindingConfigV1;
        try {
            binding = parseTeamDirectoryBindingConfigV1(current.bindingConfig);
        } catch {
            return false;
        }
        if (
            binding.kind !== "workos_directory"
            || binding.workosDirectoryId !== expectedCurrentness.workosDirectoryId
            || current.teamIdentityConnectionId !== expectedCurrentness.teamIdentityConnectionId
        ) return false;
        const runtime = await resolveTeamWorkosConnectionRuntimeInTx(tx, {
            env, teamId: current.teamId, connectionId: current.teamIdentityConnectionId,
            purpose: "directory",
        });
        return runtime.status === "ready"
            && runtime.connection.externalReference.organizationId === expectedCurrentness.organizationId
            && runtime.runtimeFingerprint === expectedCurrentness.runtimeFingerprint;
    }
    const connection = await tx.teamIdentityConnection.findFirst({
        where: { id: current.teamIdentityConnectionId, teamId: current.teamId },
        select: { providerInstanceId: true },
    });
    if (!connection) return false;
    return (await resolveTeamWorkosProviderInstanceInTx(tx, {
        teamId: current.teamId,
        providerInstanceId: connection.providerInstanceId,
    })).status === "ready";
}

/**
 * Authoritative admission/readiness decision for one source's completed facts.
 * Callers provide the row they read in their current transaction so readiness,
 * current Home policy, and the ensuing native mutation share one snapshot.
 */
export async function isDirectorySourceCompletedEvidenceAllowedInTx(
    tx: Tx,
    source: DirectorySourceCompletedEvidence,
    expectedCurrentness?: ExpectedDirectorySourceCurrentness,
): Promise<boolean> {
    return isDirectorySourceProjectionComplete(source)
        && await isDirectorySourceAllowedInTx(tx, source, expectedCurrentness);
}
