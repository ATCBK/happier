import { z } from "zod/mini";

import { AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS, AuthTokenAuthenticationEvidenceV1Schema } from '@happier-dev/protocol/auth/authToken';

import { decryptString, encryptString } from "@/modules/encrypt";

/**
 * The server-stamped authentication facts of the request that started a GitHub
 * App setup, as persisted on the OAuth attempt and the manifest continuation.
 *
 * GitHub returns the administrator through a browser redirect that carries no
 * Happier credential, so the finalizer re-runs the same authorization with the
 * facts the server observed on the initiating request. It is never a claim the
 * client can author: the attempt value is server-written and signed-state bound.
 */
export const GitHubAppManagementAuthenticationV1Schema = z.strictObject({
    authenticationAuthority: z.enum(["present_user", "account_automation"]),
    authenticationEvidence: z.optional(z.array(AuthTokenAuthenticationEvidenceV1Schema).check(z.maxLength(AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS))),
});

export type GitHubAppManagementAuthenticationV1 = z.infer<typeof GitHubAppManagementAuthenticationV1Schema>;

const GitHubAppRegistrationConfigV1Schema = z.strictObject({
    v: z.literal(1),
    secretHealth: z.optional(z.strictObject({
        clientSecretConfigured: z.boolean(),
        privateKeyConfigured: z.boolean(),
        webhookSecretConfigured: z.boolean(),
    })),
});

export type GitHubAppRegistrationConfigV1 = z.infer<typeof GitHubAppRegistrationConfigV1Schema>;

export function parseGitHubAppRegistrationConfigV1(value: unknown): GitHubAppRegistrationConfigV1 {
    return GitHubAppRegistrationConfigV1Schema.parse(value);
}

const GitHubAppRegistrationSecretsV1Schema = z.strictObject({
    v: z.literal(1),
    clientSecret: z.optional(z.string().check(z.minLength(1))),
    privateKey: z.optional(z.string().check(z.minLength(1))),
    webhookSecret: z.optional(z.string().check(z.minLength(1))),
});

export type GitHubAppRegistrationSecretsV1 = z.infer<typeof GitHubAppRegistrationSecretsV1Schema>;

export type GitHubAppRegistrationSecretReplacementV1 = Readonly<{
    clientSecret?: string | null;
    privateKey?: string | null;
    webhookSecret?: string | null;
}>;

export function createGitHubAppRegistrationConfigV1(
    secrets: GitHubAppRegistrationSecretsV1,
): GitHubAppRegistrationConfigV1 {
    return GitHubAppRegistrationConfigV1Schema.parse({
        v: 1,
        secretHealth: projectGitHubAppSecretHealthV1(secrets),
    });
}

export function githubAppRegistrationSecretEncryptionPathV1(registrationId: string): string[] {
    return [
        "storage",
        "github_app_registration",
        registrationId,
        "secrets",
        "v1",
    ];
}

export function encryptGitHubAppRegistrationSecretsV1(params: Readonly<{
    registrationId: string;
    secrets: GitHubAppRegistrationSecretsV1;
}>): Uint8Array<ArrayBuffer> {
    const secrets = GitHubAppRegistrationSecretsV1Schema.parse(params.secrets);
    return encryptString(
        githubAppRegistrationSecretEncryptionPathV1(params.registrationId),
        JSON.stringify(secrets),
    );
}

export function decryptGitHubAppRegistrationSecretsV1(params: Readonly<{
    registrationId: string;
    encryptedSecrets: Uint8Array<ArrayBuffer>;
}>): GitHubAppRegistrationSecretsV1 {
    const plaintext = decryptString(
        githubAppRegistrationSecretEncryptionPathV1(params.registrationId),
        params.encryptedSecrets,
    );
    return GitHubAppRegistrationSecretsV1Schema.parse(JSON.parse(plaintext));
}

export function applyGitHubAppSecretReplacementV1(
    current: GitHubAppRegistrationSecretsV1,
    replacement: GitHubAppRegistrationSecretReplacementV1,
): GitHubAppRegistrationSecretsV1 {
    const parsedCurrent = GitHubAppRegistrationSecretsV1Schema.parse(current);
    const next: GitHubAppRegistrationSecretsV1 = {
        v: 1,
        ...(replacement.clientSecret === undefined
            ? parsedCurrent.clientSecret === undefined ? {} : { clientSecret: parsedCurrent.clientSecret }
            : replacement.clientSecret === null ? {} : { clientSecret: replacement.clientSecret }),
        ...(replacement.privateKey === undefined
            ? parsedCurrent.privateKey === undefined ? {} : { privateKey: parsedCurrent.privateKey }
            : replacement.privateKey === null ? {} : { privateKey: replacement.privateKey }),
        ...(replacement.webhookSecret === undefined
            ? parsedCurrent.webhookSecret === undefined ? {} : { webhookSecret: parsedCurrent.webhookSecret }
            : replacement.webhookSecret === null ? {} : { webhookSecret: replacement.webhookSecret }),
    };
    return GitHubAppRegistrationSecretsV1Schema.parse(next);
}

export type GitHubAppSecretHealthV1 = Readonly<{
    clientSecretConfigured: boolean;
    privateKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
}>;

/** Decrypted health admitted for this exact registration revision in the same transaction. */
export type GitHubAppRegistrationSecretHealthFact = Readonly<{
    registrationId: string;
    securityRevision: number;
    /** Unreadable ciphertext remains an explicit refusal, never inferred configuration. */
    secretHealth: GitHubAppSecretHealthV1 | null;
}>;

export function projectGitHubAppSecretHealthV1(
    secrets: GitHubAppRegistrationSecretsV1,
): GitHubAppSecretHealthV1 {
    const parsed = GitHubAppRegistrationSecretsV1Schema.parse(secrets);
    return Object.freeze({
        clientSecretConfigured: parsed.clientSecret !== undefined,
        privateKeyConfigured: parsed.privateKey !== undefined,
        webhookSecretConfigured: parsed.webhookSecret !== undefined,
    });
}

const GitHubPermissionLevelV1Schema = z.enum(["read", "write"]);
const GitHubPermissionsV1Schema = z.record(
    z.string().check(z.minLength(1)),
    GitHubPermissionLevelV1Schema,
);
export type GitHubPermissionsV1 = z.infer<typeof GitHubPermissionsV1Schema>;

export function parseGitHubPermissionsV1(value: unknown): GitHubPermissionsV1 {
    return GitHubPermissionsV1Schema.parse(value);
}
const GitHubEventsV1Schema = z.array(z.string().check(z.minLength(1)));
const GitHubRepositorySelectionV1Schema = z.enum(["all", "selected"]);

const GitHubAppInstallationEvidenceV1Schema = z.strictObject({
    githubAppId: z.bigint().check(z.positive()),
    githubInstallationId: z.bigint().check(z.positive()),
    githubOrganizationId: z.bigint().check(z.positive()),
    githubOrganizationLogin: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    suspended: z.boolean(),
    permissions: GitHubPermissionsV1Schema,
    events: GitHubEventsV1Schema,
    repositorySelection: GitHubRepositorySelectionV1Schema,
});

export type GitHubAppInstallationEvidenceV1 = z.infer<typeof GitHubAppInstallationEvidenceV1Schema>;

export type GitHubAppInstallationEvidenceResultV1 =
    | Readonly<{
        ok: true;
        value: Readonly<Omit<GitHubAppInstallationEvidenceV1,
            "githubAppId" | "githubInstallationId" | "githubOrganizationId">>;
    }>
    | Readonly<{
        ok: false;
        code:
            | "github_installation_evidence_invalid"
            | "github_app_mismatch"
            | "github_installation_mismatch"
            | "github_organization_mismatch"
            | "github_permission_missing";
        permission?: string;
    }>;

export function validateGitHubAppInstallationEvidenceV1(params: Readonly<{
    expected: Readonly<{
        githubAppId: bigint;
        githubInstallationId: bigint;
        githubOrganizationId: bigint;
        requiredPermissions?: Readonly<Record<string, "read" | "write">>;
    }>;
    observed: unknown;
}>): GitHubAppInstallationEvidenceResultV1 {
    const parsed = GitHubAppInstallationEvidenceV1Schema.safeParse(params.observed);
    if (!parsed.success) return { ok: false, code: "github_installation_evidence_invalid" };
    if (parsed.data.githubAppId !== params.expected.githubAppId) {
        return { ok: false, code: "github_app_mismatch" };
    }
    if (parsed.data.githubInstallationId !== params.expected.githubInstallationId) {
        return { ok: false, code: "github_installation_mismatch" };
    }
    if (parsed.data.githubOrganizationId !== params.expected.githubOrganizationId) {
        return { ok: false, code: "github_organization_mismatch" };
    }
    for (const [permission, required] of Object.entries(params.expected.requiredPermissions ?? {})) {
        if (!permissionSatisfies(parsed.data.permissions[permission], required)) {
            return { ok: false, code: "github_permission_missing", permission };
        }
    }
    return {
        ok: true,
        value: {
            githubOrganizationLogin: parsed.data.githubOrganizationLogin,
            suspended: parsed.data.suspended,
            permissions: parsed.data.permissions,
            events: parsed.data.events,
            repositorySelection: parsed.data.repositorySelection,
        },
    };
}

export type GitHubAppConsumerPurposeV1 =
    | Readonly<{ kind: "identity"; requiresOrganizationEvidence: boolean }>
    | Readonly<{ kind: "directorySync" }>
    | Readonly<{
        kind: "repository";
        requiredPermissions: Readonly<Record<string, "read" | "write">>;
        requiredEvents: readonly string[];
        requiresWebhookSecret: boolean;
    }>;

export type GitHubAppConsumerReadinessResultV1 =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code:
            | "github_app_not_configured"
            | "github_installation_unverified"
            | "github_installation_suspended"
            | "github_permission_missing"
            | "github_event_missing"
            | "github_webhook_secret_missing";
        permission?: string;
        event?: string;
    }>;

function permissionSatisfies(
    actual: "read" | "write" | undefined,
    required: "read" | "write",
): boolean {
    return actual === "write" || actual === required;
}

/** What one consumer purpose needs from the registration and the installation. */
export type GitHubAppConsumerRequirementsV1 = Readonly<{
    needsClientSecret: boolean;
    needsPrivateKey: boolean;
    needsWebhookSecret: boolean;
    permissions: Readonly<Record<string, "read" | "write">>;
    events: readonly string[];
}>;

/**
 * The single requirement table for every GitHub App consumer purpose. Readiness
 * enforces it and the administration projection displays it, so an operator
 * repairing least privilege reads exactly the rule the Home applies.
 */
export function resolveGitHubAppConsumerRequirementsV1(
    purpose: GitHubAppConsumerPurposeV1,
): GitHubAppConsumerRequirementsV1 {
    if (purpose.kind === "identity") {
        return {
            needsClientSecret: true,
            needsPrivateKey: purpose.requiresOrganizationEvidence,
            needsWebhookSecret: false,
            permissions: purpose.requiresOrganizationEvidence ? { members: "read" } : {},
            events: [],
        };
    }
    if (purpose.kind === "directorySync") {
        return {
            needsClientSecret: false,
            needsPrivateKey: true,
            needsWebhookSecret: false,
            permissions: { members: "read" },
            events: [],
        };
    }
    return {
        needsClientSecret: false,
        needsPrivateKey: true,
        needsWebhookSecret: purpose.requiresWebhookSecret,
        permissions: purpose.requiredPermissions,
        events: purpose.requiredEvents,
    };
}

/**
 * The union of what this installation's current consumers require, paired with
 * what the last verification observed. `missing*` is the repair list an
 * administrator acts on; an installation with no consumer requires nothing.
 */
export function projectGitHubAppInstallationRequirementsV1(input: Readonly<{
    purposes: readonly GitHubAppConsumerPurposeV1[];
    permissions: Readonly<Record<string, "read" | "write">>;
    events: readonly string[];
}>): Readonly<{
    permissions: Readonly<Record<string, "read" | "write">>;
    events: readonly string[];
    missingPermissions: readonly Readonly<{ permission: string; required: "read" | "write" }>[];
    missingEvents: readonly string[];
}> {
    const permissions = new Map<string, "read" | "write">();
    const events = new Set<string>();
    for (const purpose of input.purposes) {
        const requirements = resolveGitHubAppConsumerRequirementsV1(purpose);
        for (const [permission, required] of Object.entries(requirements.permissions)) {
            // "write" subsumes "read", so the union keeps the strongest ask.
            if (required === "write" || !permissions.has(permission)) permissions.set(permission, required);
        }
        for (const event of requirements.events) events.add(event);
    }
    const observedEvents = new Set(input.events);
    return {
        permissions: Object.fromEntries([...permissions].sort(([left], [right]) => left.localeCompare(right))),
        events: [...events].sort((left, right) => left.localeCompare(right)),
        missingPermissions: [...permissions]
            .filter(([permission, required]) => !permissionSatisfies(input.permissions[permission], required))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([permission, required]) => ({ permission, required })),
        missingEvents: [...events].filter((event) => !observedEvents.has(event))
            .sort((left, right) => left.localeCompare(right)),
    };
}

export function resolveGitHubAppConsumerReadinessV1(input: Readonly<{
    purpose: GitHubAppConsumerPurposeV1;
    registration: Readonly<{
        state: string;
        secretHealth: GitHubAppSecretHealthV1;
    }>;
    installation: Readonly<{
        state: string;
        suspended: boolean;
        permissions: Readonly<Record<string, "read" | "write">>;
        events: readonly string[];
    }>;
}>): GitHubAppConsumerReadinessResultV1 {
    if (input.registration.state !== "verified") {
        return { ok: false, code: "github_app_not_configured" };
    }
    if (input.installation.state !== "verified") {
        return { ok: false, code: "github_installation_unverified" };
    }
    if (input.installation.suspended) {
        return { ok: false, code: "github_installation_suspended" };
    }

    const requirements = resolveGitHubAppConsumerRequirementsV1(input.purpose);

    if (requirements.needsClientSecret && !input.registration.secretHealth.clientSecretConfigured) {
        return { ok: false, code: "github_app_not_configured" };
    }
    if (requirements.needsPrivateKey && !input.registration.secretHealth.privateKeyConfigured) {
        return { ok: false, code: "github_app_not_configured" };
    }
    if (requirements.needsWebhookSecret && !input.registration.secretHealth.webhookSecretConfigured) {
        return { ok: false, code: "github_webhook_secret_missing" };
    }
    for (const [permission, required] of Object.entries(requirements.permissions)) {
        if (!permissionSatisfies(input.installation.permissions[permission], required)) {
            return { ok: false, code: "github_permission_missing", permission };
        }
    }
    const actualEvents = new Set(input.installation.events);
    for (const event of requirements.events) {
        if (!actualEvents.has(event)) return { ok: false, code: "github_event_missing", event };
    }
    return { ok: true };
}
