import type {
    DirectoryGroup,
    DirectoryGroupMember,
    DirectoryPerson,
} from "@/app/teams/directory/directorySourceEvidence";
import { parseTeamDirectoryBindingConfigV1 } from "@/app/teams/directory/directorySourceBinding";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { resolveManagedIdentityNetworkPolicy } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { readHomeGovernancePolicy } from "@/app/home/governance/governancePolicy";
import type { HomeGovernancePolicyRecord } from "@/app/home/governance/governancePolicy";
import {
    decryptGitHubAppRegistrationSecretsV1,
    parseGitHubAppRegistrationConfigV1,
    parseGitHubPermissionsV1,
    projectGitHubAppSecretHealthV1,
    resolveGitHubAppConsumerReadinessV1,
    validateGitHubAppInstallationEvidenceV1,
    type GitHubAppRegistrationSecretHealthFact,
    type GitHubAppSecretHealthV1,
} from "./githubManagedApp";
import { readGitHubAppInstallationEvidence } from "./githubAppInstallationClient";
import {
    classifyGitHubDirectoryRequestFailure,
    GITHUB_MAX_DIRECTORY_PAGE_SIZE,
    readPurposeNarrowedGitHubDirectoryPage,
} from "./githubDirectoryAdapter";
import {
    isGitHubAppRegistrationOwnerEligible,
    isManagedGitHubHostApprovedByHome,
} from "./githubAppInstallationEligibility";

const GITHUB_DEFAULT_PAGE_SIZE = GITHUB_MAX_DIRECTORY_PAGE_SIZE;

const contextBrand: unique symbol = Symbol("ManagedGitHubDirectoryReadContext");

export interface ManagedGitHubDirectoryReadContext {
    readonly directorySourceId: string;
    readonly githubInstallationId: bigint;
    readonly registrationSecurityRevision: number;
    readonly installationRevision: number;
    readonly networkPolicyFingerprint: string;
    readonly githubOrganizationId: bigint;
    readonly organizationLogin: string;
    readonly [contextBrand]: true;
}

export type ManagedGitHubDirectoryResource =
    | Readonly<{ kind: "organization_members" }>
    | Readonly<{ kind: "organization_teams" }>
    | Readonly<{ kind: "team_members"; githubTeamId: bigint }>;

export type ManagedGitHubDirectoryFailureCode =
    | "directory_source_unavailable"
    | "installation_unavailable"
    | "installation_stale"
    | "organization_unresolved"
    | "permission_lost"
    | "rate_limited"
    | "upstream_unavailable"
    | "malformed_response"
    | "request_timeout"
    | "request_cancelled";

export type ManagedGitHubDirectoryFailure = Readonly<{
    ok: false;
    code: ManagedGitHubDirectoryFailureCode;
    upstreamStatus?: number;
    retryAfterMs?: number;
}>;

export type BeginManagedGitHubDirectoryReadResult =
    | Readonly<{
        ok: true;
        context: ManagedGitHubDirectoryReadContext;
        organizationLogin: string;
    }>
    | ManagedGitHubDirectoryFailure;

export type ManagedGitHubDirectoryPageResult =
    | Readonly<{
        ok: true;
        items: readonly (DirectoryPerson | DirectoryGroup | DirectoryGroupMember)[];
        nextCursor: string | null;
    }>
    | ManagedGitHubDirectoryFailure;

const sourceInclude = {
    githubAppInstallation: {
        include: { registration: true },
    },
} as const;

type SourceRow = NonNullable<Awaited<ReturnType<typeof readDirectorySource>>>;

async function readDirectorySource(directorySourceId: string) {
    return await db.teamDirectorySource.findUnique({
        where: { id: directorySourceId },
        include: sourceInclude,
    });
}

function isUsableSourceState(state: string): boolean {
    return state === "initializing" || state === "active";
}

type ResolvedManagedDirectory = Readonly<{
    source: SourceRow;
    installation: NonNullable<SourceRow["githubAppInstallation"]>;
    registration: NonNullable<SourceRow["githubAppInstallation"]>["registration"];
    organizationLogin: string;
    privateKey: string;
    network: ReturnType<typeof resolveManagedIdentityNetworkPolicy>;
}>;

export type StoredGitHubDirectoryReadinessInput = Readonly<{
    teamId: string;
    home: HomeGovernancePolicyRecord;
    /** Safe health captured by the GitHub owner in this same transaction. */
    registrationSecretHealth?: GitHubAppRegistrationSecretHealthFact;
    installation: Readonly<{
        state: string;
        suspendedAt: Date | null;
        verifiedPermissions: unknown;
        registration: Readonly<{
            id: string;
            ownerTeamId: string | null;
            state: string;
            githubHost: string;
            config: unknown;
            encryptedSecrets: Uint8Array;
            securityRevision: number;
        }>;
    }>;
}>;

type StoredGitHubDirectoryReadiness =
    | Readonly<{ ok: true; privateKey: string }>
    | ManagedGitHubDirectoryFailure;

type StoredGitHubDirectorySecrets = Readonly<{
    privateKey: string | undefined;
    secretHealth: GitHubAppSecretHealthV1;
}>;

function readStoredGitHubDirectoryScopeFailure(
    input: StoredGitHubDirectoryReadinessInput,
): ManagedGitHubDirectoryFailure | null {
    const { installation, home } = input;
    const registration = installation.registration;
    if (!isManagedGitHubHostApprovedByHome(home, registration.githubHost)) {
        return { ok: false, code: "installation_unavailable" };
    }
    if (!isGitHubAppRegistrationOwnerEligible(
        registration.ownerTeamId,
        { kind: "team", teamId: input.teamId },
    )) {
        return { ok: false, code: "directory_source_unavailable" };
    }
    return null;
}

function evaluateStoredGitHubDirectorySecretHealth(
    input: StoredGitHubDirectoryReadinessInput,
    secretHealth: GitHubAppSecretHealthV1,
): Readonly<{ ok: true }> | ManagedGitHubDirectoryFailure {
    const { installation } = input;
    try {
        const readiness = resolveGitHubAppConsumerReadinessV1({
            purpose: { kind: "directorySync" },
            registration: { state: installation.registration.state, secretHealth },
            installation: {
                state: installation.state,
                suspended: installation.suspendedAt !== null,
                permissions: parseGitHubPermissionsV1(installation.verifiedPermissions),
                events: [],
            },
        });
        return readiness.ok ? { ok: true } : {
            ok: false,
            code: readiness.code === "github_permission_missing" ? "permission_lost" : "installation_unavailable",
        };
    } catch {
        return { ok: false, code: "installation_unavailable" };
    }
}

function evaluateStoredGitHubDirectoryReadiness(
    input: StoredGitHubDirectoryReadinessInput,
    secretsByRegistration = new Map<string, StoredGitHubDirectorySecrets | null>(),
): StoredGitHubDirectoryReadiness {
    const scopeFailure = readStoredGitHubDirectoryScopeFailure(input);
    if (scopeFailure) return scopeFailure;
    const registration = input.installation.registration;
    const registrationKey = JSON.stringify([registration.id, registration.securityRevision]);
    try {
        let secrets = secretsByRegistration.get(registrationKey);
        if (secrets === undefined) {
            try {
                parseGitHubAppRegistrationConfigV1(registration.config);
                const decrypted = decryptGitHubAppRegistrationSecretsV1({
                    registrationId: registration.id,
                    encryptedSecrets: Uint8Array.from(registration.encryptedSecrets),
                });
                secrets = { privateKey: decrypted.privateKey, secretHealth: projectGitHubAppSecretHealthV1(decrypted) };
                secretsByRegistration.set(registrationKey, secrets);
            } catch {
                secretsByRegistration.set(registrationKey, null);
                return { ok: false, code: "installation_unavailable" };
            }
        }
        if (secrets === null) return { ok: false, code: "installation_unavailable" };
        const readiness = evaluateStoredGitHubDirectorySecretHealth(input, secrets.secretHealth);
        if (!readiness.ok) return readiness;
        return secrets.privateKey
            ? { ok: true, privateKey: secrets.privateKey }
            : { ok: false, code: "installation_unavailable" };
    } catch {
        return { ok: false, code: "installation_unavailable" };
    }
}

/** Canonical persisted readiness decision shared by setup, create, and reads. */
export function resolveStoredGitHubDirectoryReadiness(
    input: StoredGitHubDirectoryReadinessInput,
): Readonly<{ ok: true }> | ManagedGitHubDirectoryFailure {
    return resolveStoredGitHubDirectoryReadinessBatch([{ ...input, key: "single" }]).get("single")!;
}

/** Evaluate one admitted snapshot, retaining decrypted material only for this call. */
export function resolveStoredGitHubDirectoryReadinessBatch(
    inputs: readonly (StoredGitHubDirectoryReadinessInput & Readonly<{ key: string }>)[],
): ReadonlyMap<string, Readonly<{ ok: true }> | ManagedGitHubDirectoryFailure> {
    const secretsByRegistration = new Map<string, StoredGitHubDirectorySecrets | null>();
    return new Map(inputs.map(input => {
        const fact = input.registrationSecretHealth;
        if (fact && fact.registrationId === input.installation.registration.id
            && fact.securityRevision === input.installation.registration.securityRevision) {
            const safe = readStoredGitHubDirectoryScopeFailure(input)
                ?? (fact.secretHealth === null ? { ok: false as const, code: "installation_unavailable" as const }
                    : evaluateStoredGitHubDirectorySecretHealth(input, fact.secretHealth));
            return [input.key, safe] as const;
        }
        const result = evaluateStoredGitHubDirectoryReadiness(input, secretsByRegistration);
        const safe: Readonly<{ ok: true }> | ManagedGitHubDirectoryFailure = result.ok ? { ok: true } : result;
        return [input.key, safe] as const;
    }));
}

async function resolveManagedDirectory(
    directorySourceId: string,
): Promise<Readonly<{ ok: true; value: ResolvedManagedDirectory }> | ManagedGitHubDirectoryFailure> {
    const source = await readDirectorySource(directorySourceId);
    if (!source || source.kind !== "github_organization" || !isUsableSourceState(source.state)) {
        return { ok: false, code: "directory_source_unavailable" };
    }
    const installation = source.githubAppInstallation;
    if (!installation) return { ok: false, code: "installation_unavailable" };
    const registration = installation.registration;
    const home = await readHomeGovernancePolicy();
    let binding: ReturnType<typeof parseTeamDirectoryBindingConfigV1>;
    try {
        binding = parseTeamDirectoryBindingConfigV1(source.bindingConfig);
    } catch {
        return { ok: false, code: "installation_unavailable" };
    }
    if (binding.kind !== "github_organization") {
        return { ok: false, code: "directory_source_unavailable" };
    }
    const readiness = evaluateStoredGitHubDirectoryReadiness({
        teamId: source.teamId,
        home,
        installation,
    });
    if (!readiness.ok) return readiness;
    return {
        ok: true,
        value: {
            source,
            installation,
            registration,
            organizationLogin: installation.githubOrganizationLogin,
            privateKey: readiness.privateKey,
            network: resolveManagedIdentityNetworkPolicy({
                env: process.env,
                timeoutSeconds: 30,
                home,
            }),
        },
    };
}

function hasExpectedTuple(
    context: ManagedGitHubDirectoryReadContext,
    resolved: ResolvedManagedDirectory,
): boolean {
    return context.directorySourceId === resolved.source.id
        && context.githubInstallationId === resolved.installation.githubInstallationId
        && context.registrationSecurityRevision === resolved.registration.securityRevision
        && context.installationRevision === resolved.installation.revision
        && context.networkPolicyFingerprint === resolved.network.fingerprint;
}

async function refreshOrganizationLogin(
    resolved: ResolvedManagedDirectory,
    organizationLogin: string,
): Promise<boolean> {
    return await inTx(async (tx) => {
        const current = await tx.teamDirectorySource.findUnique({
            where: { id: resolved.source.id },
            include: sourceInclude,
        });
        const installation = current?.githubAppInstallation;
        if (
            !current
            || current.teamId !== resolved.source.teamId
            || current.kind !== "github_organization"
            || !isUsableSourceState(current.state)
            || !installation
            || installation.id !== resolved.installation.id
            || installation.revision !== resolved.installation.revision
            || installation.githubInstallationId !== resolved.installation.githubInstallationId
            || installation.githubOrganizationId !== resolved.installation.githubOrganizationId
            || installation.registration.githubAppId !== resolved.registration.githubAppId
            || installation.registration.securityRevision !== resolved.registration.securityRevision
        ) return false;
        if (installation.githubOrganizationLogin === organizationLogin) return true;
        await tx.gitHubAppInstallation.update({
            where: { id: installation.id },
            data: { githubOrganizationLogin: organizationLogin },
        });
        await tx.teamDirectorySource.update({
            where: { id: current.id },
            data: {
                displayName: organizationLogin,
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: organizationLogin },
            },
        });
        return true;
    }, { isolationLevel: "Serializable" /* Directory refresh compares source currentness before updating the observed directory revision. */ });
}

export async function beginManagedGitHubDirectoryRead(
    params: Readonly<{ directorySourceId: string }>,
): Promise<BeginManagedGitHubDirectoryReadResult> {
    const resolved = await resolveManagedDirectory(params.directorySourceId);
    if (!resolved.ok) return resolved;
    let observed: Awaited<ReturnType<typeof readGitHubAppInstallationEvidence>>;
    try {
        observed = await readGitHubAppInstallationEvidence({
            githubHost: resolved.value.registration.githubHost,
            githubAppId: resolved.value.registration.githubAppId,
            privateKey: resolved.value.privateKey,
            githubInstallationId: resolved.value.installation.githubInstallationId,
            networkPolicy: resolved.value.network.policy,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            return { ok: false, code: "request_timeout" };
        }
        if (error instanceof DOMException && error.name === "AbortError") {
            return { ok: false, code: "request_cancelled" };
        }
        return classifyGitHubDirectoryRequestFailure(error, new AbortController().signal);
    }
    const evidence = validateGitHubAppInstallationEvidenceV1({
        expected: {
            githubAppId: resolved.value.registration.githubAppId,
            githubInstallationId: resolved.value.installation.githubInstallationId,
            githubOrganizationId: resolved.value.installation.githubOrganizationId,
        },
        observed,
    });
    if (!evidence.ok) return { ok: false, code: "installation_unavailable" };
    let currentPermissions: ReturnType<typeof parseGitHubPermissionsV1>;
    try {
        currentPermissions = parseGitHubPermissionsV1(evidence.value.permissions);
    } catch {
        return { ok: false, code: "permission_lost" };
    }
    const currentReadiness = resolveGitHubAppConsumerReadinessV1({
        purpose: { kind: "directorySync" },
        registration: {
            state: "verified",
            secretHealth: {
                privateKeyConfigured: true,
                clientSecretConfigured: false,
                webhookSecretConfigured: false,
            },
        },
        installation: {
            state: "verified",
            suspended: evidence.value.suspended,
            permissions: currentPermissions,
            events: evidence.value.events,
        },
    });
    if (!currentReadiness.ok) {
        return {
            ok: false,
            code: currentReadiness.code === "github_permission_missing"
                ? "permission_lost"
                : "installation_unavailable",
        };
    }
    if (evidence.value.githubOrganizationLogin !== resolved.value.organizationLogin) {
        if (!await refreshOrganizationLogin(resolved.value, evidence.value.githubOrganizationLogin)) {
            return { ok: false, code: "installation_stale" };
        }
    }
    return {
        ok: true,
        context: Object.freeze({
            directorySourceId: resolved.value.source.id,
            githubInstallationId: resolved.value.installation.githubInstallationId,
            registrationSecurityRevision: resolved.value.registration.securityRevision,
            installationRevision: resolved.value.installation.revision,
            networkPolicyFingerprint: resolved.value.network.fingerprint,
            githubOrganizationId: resolved.value.installation.githubOrganizationId,
            organizationLogin: evidence.value.githubOrganizationLogin,
            [contextBrand]: true as const,
        }),
        organizationLogin: evidence.value.githubOrganizationLogin,
    };
}

function parseCursor(cursor: string | null | undefined): number {
    if (cursor === null || cursor === undefined) return 1;
    const match = /^v1:([1-9][0-9]*)$/.exec(cursor);
    const page = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(page)) throw new RangeError("Invalid managed GitHub directory cursor");
    return page;
}

function parsePageSize(pageSize: number | undefined): number {
    const value = pageSize ?? GITHUB_DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(value) || value < 1 || value > GITHUB_MAX_DIRECTORY_PAGE_SIZE) {
        throw new RangeError(
            `Managed GitHub directory pageSize must be between 1 and ${GITHUB_MAX_DIRECTORY_PAGE_SIZE}`,
        );
    }
    return value;
}

function bigintToSafeNumber(value: bigint): number | null {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
}

export async function readManagedGitHubDirectoryPage(params: Readonly<{
    context: ManagedGitHubDirectoryReadContext;
    resource: ManagedGitHubDirectoryResource;
    cursor?: string | null;
    pageSize?: number;
    signal?: AbortSignal;
}>): Promise<ManagedGitHubDirectoryPageResult> {
    const page = parseCursor(params.cursor);
    const pageSize = parsePageSize(params.pageSize);
    if (params.resource.kind === "team_members" && params.resource.githubTeamId <= 0n) {
        throw new RangeError("Managed GitHub team ID must be positive");
    }

    const before = await resolveManagedDirectory(params.context.directorySourceId);
    if (!before.ok) return before;
    if (!hasExpectedTuple(params.context, before.value)) return { ok: false, code: "installation_stale" };

    const resource = params.resource.kind === "team_members"
        ? {
            kind: "team_members" as const,
            githubTeamId: bigintToSafeNumber(params.resource.githubTeamId) ?? Number.NaN,
        }
        : params.resource;
    const directoryPage = await readPurposeNarrowedGitHubDirectoryPage({
        githubHost: before.value.registration.githubHost,
        githubAppId: before.value.registration.githubAppId,
        privateKey: before.value.privateKey,
        githubInstallationId: before.value.installation.githubInstallationId,
        networkPolicy: before.value.network.policy,
        organizationLogin: params.context.organizationLogin,
        organizationId: bigintToSafeNumber(before.value.installation.githubOrganizationId) ?? Number.NaN,
        resource,
        page,
        perPage: pageSize,
        signal: params.signal,
    });
    if (!directoryPage.ok) return directoryPage;

    const after = await resolveManagedDirectory(params.context.directorySourceId);
    if (!after.ok || !hasExpectedTuple(params.context, after.value)) {
        return { ok: false, code: "installation_stale" };
    }
    return {
        ok: true,
        items: directoryPage.items,
        nextCursor: directoryPage.hasMore ? `v1:${page + 1}` : null,
    };
}
