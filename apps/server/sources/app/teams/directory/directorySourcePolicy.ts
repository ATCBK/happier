import type { ManagedIdentityProviderKindV1 } from '@happier-dev/protocol/home/governance';

import {
    readHomeGovernancePolicyInTx,
    resolveTeamProviderKindPolicy,
    type HomeGovernancePolicyRecord,
} from "@/app/home/governance/governancePolicy";
import type { Tx } from "@/storage/inTx";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import {
    resolveTeamWorkosConnectionRuntimeInTx,
    resolveTeamWorkosProviderInstanceInTx,
    resolveTeamWorkosProviderInstanceFromRuntimeResult,
} from "@/app/auth/providers/workos/teamWorkosConnectionRuntime";
import {
    resolveManagedIdentityNetworkPolicyInTx,
} from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { resolveStoredGitHubDirectoryReadiness, resolveStoredGitHubDirectoryReadinessBatch } from "@/app/integrations/github/githubManagedDirectory";
import type { ManagedGitHubDirectoryReadContext } from "@/app/integrations/github/githubManagedDirectory";
import { readIdentityProviderRuntimeFactsByIdsInTx, resolveIdentityProviderRuntimeForOwner } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import type { IdentityProviderRuntimeCurrentness } from "@/app/auth/providers/identityProviderCatalog";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { teamIdentityConnectionReferenceKey } from "../identity/teamIdentityConnectionLifecycle";

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
    return await resolveDirectorySourceAllowedInTx(tx, source, expectedCurrentness, env);
}

type DirectorySourcePolicyAdmission = Readonly<{
    home: HomeGovernancePolicyRecord;
    source: Awaited<ReturnType<typeof readDirectorySourceAuthoritiesInTx>>[number] | undefined;
    workosProviderAvailable: boolean;
    githubReady: boolean;
}>;

async function resolveDirectorySourceAllowedInTx(
    tx: Tx,
    source: Pick<DirectorySourceCompletedEvidence, "id" | "kind">,
    expectedCurrentness: ExpectedDirectorySourceCurrentness | undefined,
    env: NodeJS.ProcessEnv,
    admitted?: DirectorySourcePolicyAdmission,
): Promise<boolean> {
    if (admitted) {
        if (resolveTeamProviderKindPolicy(admitted.home, resolveDirectorySourceProviderKind(source.kind)) !== "allowed") return false;
    } else if (!await isDirectorySourceKindAllowedInTx(tx, source.kind)) return false;
    if (expectedCurrentness && (
        expectedCurrentness.directorySourceId !== source.id
        || (source.kind === "github_organization") !== (expectedCurrentness.kind === "github_directory_read")
    )) return false;
    if (source.kind === "github_organization") {
        const current = admitted ? admitted.source : await tx.teamDirectorySource.findUnique({
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
        if (admitted) return admitted.githubReady;
        return resolveStoredGitHubDirectoryReadiness({
            teamId: current.teamId,
            home: await readHomeGovernancePolicyInTx(tx),
            installation: {
                state: installation.state,
                suspendedAt: installation.suspendedAt,
                verifiedPermissions: installation.verifiedPermissions,
                registration: {
                    id: installation.registration.id,
                    securityRevision: installation.registration.securityRevision,
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
    const current = admitted ? admitted.source : await tx.teamDirectorySource.findUnique({
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
    if (admitted) return admitted.workosProviderAvailable;
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

async function readDirectorySourceAuthoritiesInTx(tx: Tx, ids: readonly string[]) {
    return (await Promise.all(portableQueryChunks({ values: [...new Set(ids)], bindingsPerValue: 1, fixedBindings: 1 }).map(chunk =>
        tx.teamDirectorySource.findMany({
            where: { id: { in: [...chunk] } },
            select: {
                id: true, kind: true, teamId: true, teamIdentityConnectionId: true, bindingConfig: true,
                githubAppInstallation: { select: {
                    id: true, githubInstallationId: true, githubOrganizationId: true, githubOrganizationLogin: true,
                    revision: true, state: true, suspendedAt: true, verifiedPermissions: true,
                    registration: { select: {
                        id: true, ownerTeamId: true, state: true, githubHost: true, config: true,
                        encryptedSecrets: true, securityRevision: true,
                    } },
                } },
            },
        }),
    ))).flat();
}

/**
 * The set form of completed-evidence admission for one transaction. Feature,
 * Home, exact source/Team bindings and current provider authority are acquired
 * once; the same source predicate still makes every decision.
 */
export async function readDirectorySourceCompletedEvidenceAllowedByIdsInTx(
    tx: Tx,
    input: Readonly<{
        sources: readonly DirectorySourceCompletedEvidence[];
        home?: HomeGovernancePolicyRecord;
        runtimeCurrentness?: ReadonlyMap<string, IdentityProviderRuntimeCurrentness>;
    }>,
): Promise<ReadonlyMap<string, boolean>> {
    const result = new Map(input.sources.map(source => [source.id, false]));
    const complete = input.sources.filter(isDirectorySourceProjectionComplete);
    if (complete.length === 0 || !await isServerFeatureEnabledForHome("teams", { tx })) return result;
    const home = input.home ?? await readHomeGovernancePolicyInTx(tx);
    const allowed = complete.filter(source => resolveTeamProviderKindPolicy(home, resolveDirectorySourceProviderKind(source.kind)) === "allowed");
    if (allowed.length === 0) return result;
    const rows = await readDirectorySourceAuthoritiesInTx(tx, allowed.map(source => source.id));
    const byId = new Map(rows.map(row => [row.id, row]));
    const references = [...new Map(rows.flatMap(row => row.kind === "workos_directory" && row.teamIdentityConnectionId
        ? [[teamIdentityConnectionReferenceKey({ id: row.teamIdentityConnectionId, teamId: row.teamId }), {
            id: row.teamIdentityConnectionId, teamId: row.teamId,
        }] as const] : [])).values()];
    const connections = (await Promise.all(portableQueryChunks({ values: references, bindingsPerValue: 2, fixedBindings: 1 }).map(chunk =>
        tx.teamIdentityConnection.findMany({
            where: { OR: chunk.map(reference => ({ id: reference.id, teamId: reference.teamId })) },
            select: { id: true, teamId: true, providerInstanceId: true },
        }),
    ))).flat();
    const connectionByReference = new Map(connections.map(connection => [teamIdentityConnectionReferenceKey(connection), connection]));
    const missingProviderIds = connections.flatMap(connection => input.runtimeCurrentness?.has(connection.providerInstanceId) ? [] : [connection.providerInstanceId]);
    const providers = await readIdentityProviderRuntimeFactsByIdsInTx(tx, { ids: missingProviderIds });
    const registrationSecretHealth = new Map([...(input.runtimeCurrentness?.values() ?? [])].flatMap(currentness =>
        currentness.githubRegistrationSecretHealth ? [[JSON.stringify([currentness.githubRegistrationSecretHealth.registrationId,
            currentness.githubRegistrationSecretHealth.securityRevision]),
            currentness.githubRegistrationSecretHealth] as const] : []));
    const githubReady = resolveStoredGitHubDirectoryReadinessBatch(rows.flatMap(row => {
        const installation = row.githubAppInstallation;
        return row.kind === "github_organization" && installation ? [{
            key: row.id, teamId: row.teamId, home,
            registrationSecretHealth: registrationSecretHealth.get(JSON.stringify([installation.registration.id, installation.registration.securityRevision])),
            installation: { ...installation, registration: {
                ...installation.registration, encryptedSecrets: Uint8Array.from(installation.registration.encryptedSecrets),
            } },
        }] : [];
    }));
    for (const source of allowed) {
        const row = byId.get(source.id);
        const connection = row?.teamIdentityConnectionId
            ? connectionByReference.get(teamIdentityConnectionReferenceKey({ id: row.teamIdentityConnectionId, teamId: row.teamId }))
            : undefined;
        let workosProviderAvailable = false;
        if (connection && row) {
            const currentness = input.runtimeCurrentness?.get(connection.providerInstanceId);
            if (currentness) {
                workosProviderAvailable = currentness.workosProviderAvailable;
            } else {
                const facts = providers.get(connection.providerInstanceId);
                const teamProvider = resolveIdentityProviderRuntimeForOwner(facts, { kind: "team", teamId: row.teamId });
                const runtime = teamProvider.status === "not_found"
                    ? resolveIdentityProviderRuntimeForOwner(facts, { kind: "home" }) : teamProvider;
                workosProviderAvailable = resolveTeamWorkosProviderInstanceFromRuntimeResult(runtime).status === "ready";
            }
        }
        result.set(source.id, await resolveDirectorySourceAllowedInTx(tx, source, undefined, process.env, {
            home, source: row, workosProviderAvailable, githubReady: githubReady.get(source.id)?.ok === true,
        }));
    }
    return result;
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
