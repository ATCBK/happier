import { z } from "zod";
import { z as mini } from 'zod/mini';
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';
import { ManagedGitHubAppOwnerV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { PasswordCredentialMutationDigestV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { GitHubAppManagementAuthenticationV1Schema } from "@/app/integrations/github/githubManagedApp";
import { ProviderReferenceSchema } from "@/app/auth/providers/providerReference";
import { teamOAuthAdmissionSourceSchema } from "@/app/teams/memberships/teamOAuthAdmissionSource";

export const oauthSecurityBindingSchema = z.object({
    provider: ProviderReferenceSchema,
    connection: z.object({
        id: z.string().trim().min(1).max(512),
        revision: z.number().int().positive(),
    }).strict().nullable(),
    admission: teamOAuthAdmissionSourceSchema.nullable(),
    purpose: z.enum([
        "account_directory",
        "account_encryption_first_key",
        "account_password_enrollment",
        "team_admission",
        "identity_connection_test",
    ]).nullable(),
}).strict().superRefine((value, context) => {
    if (value.purpose !== "team_admission" && value.admission !== null) {
        context.addIssue({
            code: "custom",
            path: ["admission"],
            message: "Team admission authority requires the Team admission purpose",
        });
    }
});

export type OAuthSecurityBinding = z.infer<typeof oauthSecurityBindingSchema>;

/** A malformed new binding must never be interpreted as a released missing-reference record. */
export function hasInvalidOAuthSecurityBinding(value: unknown): boolean {
    return value !== null && typeof value === "object" && "securityBinding" in value
        && !oauthSecurityBindingSchema.safeParse(value.securityBinding).success;
}

export const oauthStateAttemptSchema = z.object({
    provider: z.string(),
    callbackProvider: z.string().optional(),
    securityBinding: oauthSecurityBindingSchema.optional(),
    pkceCodeVerifier: z.string(),
    nonce: z.string(),
    connectFinalization: z.literal("credential_adoption_v1").optional(),
    webAppOAuthReturnUrl: z.string().optional(),
    purpose: z.enum([
        "account_directory",
        "team_admission",
        "identity_connection_test",
        "github_app_installation_verification",
        "github_app_manifest_setup",
    ]).optional(),
    userId: z.string().trim().min(1).max(256).optional(),
    proofHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    requestDigest: z.union([
        AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
        PasswordCredentialMutationDigestV1Schema,
    ]).optional(),
    githubAppInstallationVerification: z.object({
        owner: ManagedGitHubAppOwnerV1Schema,
        registrationId: z.string().trim().min(1),
        registrationRevision: z.number().int().positive(),
        registrationSecurityRevision: z.number().int().positive(),
        installationRevision: z.number().int().min(0),
        networkPolicyFingerprint: z.string().trim().min(1),
        githubInstallationId: z.string().regex(/^[1-9][0-9]*$/u),
        githubOrganizationId: z.string().regex(/^[1-9][0-9]*$/u),
        authentication: mini.optional(GitHubAppManagementAuthenticationV1Schema),
    }).strict().optional(),
    githubAppManifestSetup: z.object({
        owner: ManagedGitHubAppOwnerV1Schema,
        authentication: mini.optional(GitHubAppManagementAuthenticationV1Schema),
    }).strict().optional(),
    endpointUrl: z.string().url().optional(),
    endpointServerIdentityId: z.string().trim().min(1).optional(),
    canonicalServerUrl: z.string().url().optional(),
}).strict().superRefine((value, context) => {
    const isInstallationVerification = value.purpose === "github_app_installation_verification";
    const isManifestSetup = value.purpose === "github_app_manifest_setup";
    const boundPurpose = value.securityBinding?.purpose ?? value.purpose ?? null;
    const isAccountSecurityProof = boundPurpose === "account_encryption_first_key"
        || boundPurpose === "account_password_enrollment";
    const hasAccountSecurityProof = value.userId !== undefined
        || value.proofHash !== undefined
        || value.requestDigest !== undefined;
    if (isInstallationVerification !== (value.githubAppInstallationVerification !== undefined)) {
        context.addIssue({ code: "custom", message: "GitHub App installation purpose requires its exact binding" });
    }
    if (isManifestSetup !== (value.githubAppManifestSetup !== undefined)) {
        context.addIssue({ code: "custom", message: "GitHub App manifest purpose requires its exact binding" });
    }
    if (isAccountSecurityProof) {
        const digestSchema = boundPurpose === "account_password_enrollment"
            ? PasswordCredentialMutationDigestV1Schema
            : AccountEncryptionMigrateExternalAuthBindingDigestV1Schema;
        if (
            value.userId === undefined
            || value.proofHash === undefined
            || !digestSchema.safeParse(value.requestDigest).success
        ) {
            context.addIssue({ code: "custom", message: "Account-security purpose requires its exact proof binding" });
        }
    } else if (hasAccountSecurityProof) {
        context.addIssue({ code: "custom", message: "Account-security proof binding requires its purpose" });
    }
});

export const connectPendingSchema = z.object({
    flow: z.literal("connect"),
    provider: z.string(),
    securityBinding: oauthSecurityBindingSchema.optional(),
    userId: z.string(),
    profileEnc: z.string(),
    /**
     * Absent when the provider declared `accessTokenCustody: "identity_proof_only"`: the
     * continuation carries no token because nothing after the callback reads one.
     */
    accessTokenEnc: z.string().optional(),
    refreshTokenEnc: z.string().optional(),
}).strict();

const authPendingSharedSchema = z.object({
    flow: z.literal("auth"),
    provider: z.string(),
    securityBinding: oauthSecurityBindingSchema.optional(),
    profileEnc: z.string(),
    /** See `connectPendingSchema`: an identity-proof-only provider persists no token. */
    accessTokenEnc: z.string().optional(),
    refreshTokenEnc: z.string().optional(),
    suggestedUsername: z.string().nullable().optional(),
    usernameRequired: z.boolean().optional(),
    usernameReason: z.string().nullable().optional(),
});

const authPendingLegacyKeylessSchema = authPendingSharedSchema.extend({
    authMode: z.literal("keyless"),
    proofHash: z.string(),
}).strict();

const authPendingLegacyKeyedSchema = authPendingSharedSchema.extend({
    publicKeyHex: z.string(),
}).strict();

const authPendingV2Schema = authPendingSharedSchema.extend({
    v: z.literal(2),
    authMode: z.enum(["keyed", "keyless"]).optional(),
    proofHash: z.string().optional(),
    publicKeyHex: z.string().optional(),
    purpose: z.literal("account_directory").optional(),
    endpointUrl: z.string().url().optional(),
    endpointServerIdentityId: z.string().trim().min(1).optional(),
    canonicalServerUrl: z.string().url().optional(),
}).strict().superRefine((value, ctx) => {
    const isAccountDirectory = value.purpose === "account_directory";
    const hasEndpointUrl = value.endpointUrl !== undefined;
    const hasEndpointServerIdentityId =
        value.endpointServerIdentityId !== undefined;
    const hasCanonicalServerUrl = value.canonicalServerUrl !== undefined;
    if (
        isAccountDirectory !== hasEndpointUrl
        || isAccountDirectory !== hasEndpointServerIdentityId
        || isAccountDirectory !== hasCanonicalServerUrl
    ) {
        ctx.addIssue({
            code: "custom",
            message:
                "Account Directory pending state requires an exact endpoint binding",
        });
    }
    if (!isAccountDirectory) {
        if (
            value.authMode !== undefined
            || value.publicKeyHex !== undefined
            || !value.proofHash
        ) {
            ctx.addIssue({
                code: "custom",
                message: "Ordinary v2 pending state requires its proof binding",
            });
        }
        return;
    }
    if (
        value.authMode === "keyless"
        && value.proofHash
        && value.publicKeyHex === undefined
    ) {
        return;
    }
    if (
        value.authMode === "keyed"
        && value.publicKeyHex !== undefined
        && /^[0-9a-f]{64}$/i.test(value.publicKeyHex)
        && value.proofHash === undefined
    ) {
        return;
    }
    ctx.addIssue({
        code: "custom",
        message:
            "Account Directory pending state requires exactly one keyed or keyless binding",
    });
});

export const authPendingSchema = z.union([
    authPendingV2Schema,
    authPendingLegacyKeylessSchema,
    authPendingLegacyKeyedSchema,
]);

export const accountEncryptionFirstKeyStepUpPendingSchema = z
    .object({
        v: z.literal(3),
        flow: z.literal("auth"),
        purpose:
            z.literal("account_encryption_first_key"),
        provider: z.string().min(1),
        credentialRevision: z.number().int().min(1).max(2_147_483_647).optional(),
        nativeIdentityId: z.string().min(1).max(256).optional(),
        securityBinding: oauthSecurityBindingSchema.optional(),
        userId: z.string().min(1),
        providerUserId: z.string().min(1),
        proofHash: z.string().regex(/^[0-9a-f]{64}$/),
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    })
    .strict().refine(value => value.provider === "email_password"
        ? value.credentialRevision !== undefined && value.nativeIdentityId !== undefined && value.securityBinding === undefined
        : value.credentialRevision === undefined && value.nativeIdentityId === undefined);

export const accountPasswordEnrollmentStepUpPendingSchema = z
    .object({
        v: z.literal(3),
        flow: z.literal("auth"),
        purpose: z.literal("account_password_enrollment"),
        provider: z.string().min(1),
        securityBinding: oauthSecurityBindingSchema,
        userId: z.string().min(1),
        providerUserId: z.string().min(1),
        proofHash: z.string().regex(/^[0-9a-f]{64}$/),
        requestDigest: PasswordCredentialMutationDigestV1Schema,
    })
    .strict();

export const oauthAuthPendingSchema = z.union([
    authPendingSchema,
    accountEncryptionFirstKeyStepUpPendingSchema,
    accountPasswordEnrollmentStepUpPendingSchema,
]);
