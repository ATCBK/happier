import { z } from "zod/mini";
import { normalizeOidcAllowRules } from "@/app/auth/providers/oidc/oidcProviderConfig";
import {
    TeamIdentityConnectionExternalReferenceV1Schema,
    TeamIdentityConnectionSettingsV1Schema,
    type TeamIdentityConnectionExternalReferenceV1,
    type TeamIdentityConnectionSettingsV1,
} from "@happier-dev/protocol/teams";
import { ManagedIdentityProviderKindV1Schema, type ManagedIdentityProviderKindV1 } from '@happier-dev/protocol/home/governance';

export const ManagedIdentityProviderKindSchema = ManagedIdentityProviderKindV1Schema;
export type ManagedIdentityProviderKind = ManagedIdentityProviderKindV1;

const NonEmptyStringSchema = z.string().check(z.trim(), z.minLength(1));
const StringListSchema = z.array(NonEmptyStringSchema);
const OidcAllowRulesSchema = z.strictObject({
    usersAllowlist: StringListSchema,
    emailDomains: StringListSchema,
    groupsAny: StringListSchema,
    groupsAll: StringListSchema,
});

const OidcProviderConfigSchema = z.strictObject({
    v: z.literal(1),
    kind: z.literal("oidc"),
    issuer: NonEmptyStringSchema,
    clientId: NonEmptyStringSchema,
    clientAuthenticationMethod: z._default(z.enum(["client_secret_post", "client_secret_basic"]), "client_secret_post"),
    scopes: NonEmptyStringSchema.check(z.refine((value) => value.split(/\s+/u).some((scope) => scope.toLowerCase() === "openid"), "OIDC scopes must include openid")),
    httpTimeoutSeconds: z.number().check(z.int(), z.minimum(1), z.maximum(120)),
    claims: z.strictObject({
        login: NonEmptyStringSchema,
        email: NonEmptyStringSchema,
        groups: NonEmptyStringSchema,
    }),
    allow: z.pipe(OidcAllowRulesSchema, z.transform((allow: z.infer<typeof OidcAllowRulesSchema>) => normalizeOidcAllowRules(allow))),
    fetchUserInfo: z.boolean(),
    storeRefreshToken: z.boolean(),
    ui: z.strictObject({
        buttonColor: z.nullable(NonEmptyStringSchema),
        iconHint: z.nullable(NonEmptyStringSchema),
    }),
});

const WorkosProviderConfigSchema = z.strictObject({
    v: z.literal(1),
    kind: z.literal("workos_sso"),
});

const GithubProviderConfigSchema = z.strictObject({
    v: z.literal(1),
    kind: z.literal("github_app_identity"),
});

const IdentityProviderConfigSchema = z.discriminatedUnion("kind", [
    OidcProviderConfigSchema,
    WorkosProviderConfigSchema,
    GithubProviderConfigSchema,
]);

const IdentityProviderSecretsSchema = z.strictObject({
    v: z.literal(1),
    kind: z.literal("oidc"),
    clientSecret: z.string().check(z.minLength(1)),
});

export type IdentityProviderConfig = z.infer<typeof IdentityProviderConfigSchema>;
export type OidcProviderConfig = z.infer<typeof OidcProviderConfigSchema>;
export type IdentityProviderSecrets = z.infer<typeof IdentityProviderSecretsSchema>;

export type StoredDocumentResult<T, TCode extends string> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; code: TCode }>;

export function parseIdentityProviderConfig(
    kind: string,
    value: unknown,
): StoredDocumentResult<IdentityProviderConfig, "provider_kind_not_managed" | "provider_config_unreadable"> {
    const managedKind = ManagedIdentityProviderKindSchema.safeParse(kind);
    if (!managedKind.success) return { ok: false, code: "provider_kind_not_managed" };
    const parsed = IdentityProviderConfigSchema.safeParse(value);
    if (!parsed.success || parsed.data.kind !== managedKind.data) {
        return { ok: false, code: "provider_config_unreadable" };
    }
    return { ok: true, value: parsed.data };
}

export function parseIdentityProviderSecrets(
    kind: string,
    value: unknown,
): StoredDocumentResult<IdentityProviderSecrets | null, "provider_kind_not_managed" | "provider_secret_unreadable"> {
    const managedKind = ManagedIdentityProviderKindSchema.safeParse(kind);
    if (!managedKind.success) return { ok: false, code: "provider_kind_not_managed" };
    if (managedKind.data !== "oidc") {
        return value === null
            ? { ok: true, value: null }
            : { ok: false, code: "provider_secret_unreadable" };
    }
    const parsed = IdentityProviderSecretsSchema.safeParse(value);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, code: "provider_secret_unreadable" };
}

const SuccessfulTestSchema = z.strictObject({
    runtimeFingerprint: NonEmptyStringSchema,
});
const ConnectionObservationSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        v: z.literal(1),
        kind: z.literal("oidc"),
        successfulTest: z.nullable(SuccessfulTestSchema),
    }),
    z.strictObject({
        v: z.literal(1),
        kind: z.literal("workos_sso"),
        presentation: z.nullable(z.strictObject({
            displayName: NonEmptyStringSchema,
            strategy: NonEmptyStringSchema,
            status: NonEmptyStringSchema,
            lastCheckedAt: z.iso.datetime(),
        })),
        successfulTest: z.nullable(SuccessfulTestSchema),
    }),
    z.strictObject({
        v: z.literal(1),
        kind: z.literal("github_app_identity"),
        successfulTest: z.nullable(SuccessfulTestSchema),
    }),
]);

export type TeamIdentityConnectionExternalReference = TeamIdentityConnectionExternalReferenceV1;
export type TeamIdentityConnectionSettings = TeamIdentityConnectionSettingsV1;
export type TeamIdentityConnectionObservation = z.infer<typeof ConnectionObservationSchema>;

export type TeamIdentityConnectionDocuments = Readonly<{
    externalReference: TeamIdentityConnectionExternalReference;
    settings: TeamIdentityConnectionSettings;
    lastObservation: TeamIdentityConnectionObservation | null;
    successfulTest: Readonly<{
        at: Date;
        runtimeFingerprint: string;
    }> | null;
}>;

export function parseTeamIdentityConnectionDocuments(input: Readonly<{
    providerKind: string;
    externalReference: unknown;
    settings: unknown;
    lastObservation: unknown;
    lastSuccessfulTestAt: Date | null;
}>): StoredDocumentResult<TeamIdentityConnectionDocuments, "identity_connection_document_unreadable"> {
    const providerKind = ManagedIdentityProviderKindSchema.safeParse(input.providerKind);
    const externalReference = TeamIdentityConnectionExternalReferenceV1Schema.safeParse(input.externalReference);
    const settings = TeamIdentityConnectionSettingsV1Schema.safeParse(input.settings);
    const lastObservation = input.lastObservation === null
        ? { success: true as const, data: null }
        : ConnectionObservationSchema.safeParse(input.lastObservation);
    if (
        !providerKind.success
        || !externalReference.success
        || !settings.success
        || !lastObservation.success
        || externalReference.data.kind !== providerKind.data
        || settings.data.kind !== providerKind.data
        || (lastObservation.data !== null && lastObservation.data.kind !== providerKind.data)
    ) {
        return { ok: false, code: "identity_connection_document_unreadable" };
    }

    const test = lastObservation.data?.successfulTest ?? null;
    if ((input.lastSuccessfulTestAt === null) !== (test === null)) {
        return { ok: false, code: "identity_connection_document_unreadable" };
    }

    return {
        ok: true,
        value: {
            externalReference: externalReference.data,
            settings: settings.data,
            lastObservation: lastObservation.data,
            successfulTest: test && input.lastSuccessfulTestAt
                ? { at: input.lastSuccessfulTestAt, ...test }
                : null,
        },
    };
}
