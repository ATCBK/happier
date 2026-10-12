import { parseOptionalBooleanEnv } from "@/config/env";
import { resolveDeploymentProviderSnapshot } from "@/app/auth/providers/providerModules";
import {
    AccountServicePresentationV1Schema,
    HomeSignInServicePolicyV1Schema,
    SERVER_CONFIG,
    readServerConfig,
    readServerConfigRaw,
    type AccountServicePresentationV1,
    type HomeSignInServicePolicyV1,
} from "@happier-dev/protocol";

export type AuthOffboardingMode = "per-request-cache";

export type AuthKeyChallengeV2Policy = Readonly<{
    ordinaryHomeRequired: boolean;
}>;

export function resolveAuthKeyChallengeV2Policy(
    env: NodeJS.ProcessEnv,
): AuthKeyChallengeV2Policy {
    return Object.freeze({
        ordinaryHomeRequired: readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_REQUIRE_KEY_CHALLENGE_V2),
    });
}

export function resolveAuthKeyChallengeV2Requirement(
    env: NodeJS.ProcessEnv,
): boolean {
    return resolveAuthKeyChallengeV2Policy(env).ordinaryHomeRequired;
}

export type AuthPolicy = Readonly<{
    anonymousSignupEnabled: boolean;
    signupProviders: readonly string[];
    requiredLoginProviders: readonly string[];
    signInService?: HomeSignInServicePolicyV1 | null;
    accountServicePresentation?: AccountServicePresentationV1 | null;
    configurationErrors?: readonly string[];

    offboarding: Readonly<{
        enabled: boolean;
        strict: boolean;
        intervalSeconds: number;
        mode: AuthOffboardingMode;
    }>;
}>;

function readTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
    return String(env[key] ?? "").trim();
}

function resolveSignInServicePolicy(env: NodeJS.ProcessEnv, errors: string[]): HomeSignInServicePolicyV1 | null {
    // Read raw: an unknown mode is a configuration error the policy reports, not a silent default.
    const mode = readServerConfigRaw(env, SERVER_CONFIG.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE)?.raw.trim().toLowerCase()
        || SERVER_CONFIG.HAPPIER_AUTH_SIGN_IN_SERVICE_MODE.default;
    const endpoint = readTrimmedEnv(env, "HAPPIER_AUTH_SIGN_IN_SERVICE_URL");
    const expectedServerIdentityId = readTrimmedEnv(env, "HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID");
    const hasExternalFields = Boolean(endpoint || expectedServerIdentityId);
    if ((mode === "disabled" || mode === "self") && hasExternalFields) {
        errors.push(`${mode} sign-in service mode cannot use HAPPIER_AUTH_SIGN_IN_SERVICE_URL or HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID`);
        return null;
    }
    const candidate: unknown = mode === "external"
        ? {
            v: 1,
            mode,
            endpoint,
            ...(expectedServerIdentityId ? { expectedServerIdentityId } : {}),
        }
        : { v: 1, mode };
    const parsed = HomeSignInServicePolicyV1Schema.safeParse(candidate);
    if (!parsed.success) {
        errors.push(`Invalid HAPPIER_AUTH_SIGN_IN_SERVICE_MODE configuration: ${parsed.error.issues[0]?.message ?? "invalid policy"}`);
        return null;
    }
    return parsed.data;
}

function resolveAccountServicePresentation(env: NodeJS.ProcessEnv, errors: string[]): AccountServicePresentationV1 | null {
    const displayName = readTrimmedEnv(env, "HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME");
    if (!displayName) return null;
    const parsed = AccountServicePresentationV1Schema.safeParse({ v: 1, displayName });
    if (!parsed.success) {
        errors.push(`Invalid HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: ${parsed.error.issues[0]?.message ?? "invalid display name"}`);
        return null;
    }
    return parsed.data;
}

export function narrowAuthSignInServicePolicy(
    policy: HomeSignInServicePolicyV1 | null,
    narrowing: Readonly<{ mode: "disabled" }> | null | undefined,
): HomeSignInServicePolicyV1 | null {
    return narrowing?.mode === "disabled" ? { v: 1, mode: "disabled" } : policy;
}

/**
 * Returns true only for a recognized, explicitly disabled anonymous-signup
 * setting. This is stricter than the effective signup policy because callers
 * that enable non-loopback exposure must not treat an unset or malformed
 * value as proof that signup has been closed.
 */
export function isAnonymousSignupExplicitlyDisabled(
    env: NodeJS.ProcessEnv,
): boolean {
    return parseOptionalBooleanEnv(env.AUTH_ANONYMOUS_SIGNUP_ENABLED) === false;
}

function parseCsvList(raw: string | undefined): string[] {
    if (typeof raw !== "string") return [];
    return raw
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseProvidersList(raw: string | undefined): string[] {
    return parseCsvList(raw).map((s) => s.toLowerCase());
}

function hasAnyGitHubOrgAllowlistConfigured(env: NodeJS.ProcessEnv): boolean {
    const raw = (env.AUTH_GITHUB_ALLOWED_ORGS ?? "").toString();
    return raw.trim().length > 0;
}

function hasAnyOidcAllowlistsConfigured(env: NodeJS.ProcessEnv): boolean {
    return resolveDeploymentProviderSnapshot(env).hasOidcAllowlistsConfigured;
}

/**
 * Default `AUTH_OFFBOARDING_ENABLED` behavior:
 * - If any provider allowlists are configured, offboarding defaults to enabled.
 * - Operators can always override this with `AUTH_OFFBOARDING_ENABLED`.
 *
 * Offboarding controls the *re-check schedule* for allowlist-based eligibility.
 * When allowlists exist but offboarding is disabled, users may not be revoked
 * promptly when their upstream membership changes.
 */
export function resolveDefaultAuthOffboardingEnabled(env: NodeJS.ProcessEnv): boolean {
    return hasAnyGitHubOrgAllowlistConfigured(env) || hasAnyOidcAllowlistsConfigured(env);
}

/**
 * Canonical current-policy decision for completing an external OAuth account
 * authentication with `providerId`.
 *
 * Finalizers read this immediately from current server policy rather than from
 * the pending continuation, so a provider removed from `AUTH_SIGNUP_PROVIDERS`
 * after authorization start can no longer complete an in-flight continuation.
 * A blank or unlisted provider fails closed.
 */
export function isAuthSignupProviderEnabled(
    env: NodeJS.ProcessEnv,
    providerId: string,
): boolean {
    const normalized = providerId.trim().toLowerCase();
    if (!normalized) return false;
    return resolveAuthPolicyFromEnv(env).signupProviders.includes(normalized);
}

export function resolveAuthPolicyFromEnv(env: NodeJS.ProcessEnv): AuthPolicy {
    const configurationErrors: string[] = [];
    const anonymousSignupEnabled = readServerConfig(env, SERVER_CONFIG.AUTH_ANONYMOUS_SIGNUP_ENABLED);
    const signupProviders = Object.freeze(parseProvidersList(env.AUTH_SIGNUP_PROVIDERS));
    const requiredLoginProviders = Object.freeze(parseProvidersList(env.AUTH_REQUIRED_LOGIN_PROVIDERS));

    const restrictionsExist = resolveDefaultAuthOffboardingEnabled(env);
    const defaultOffboardingEnabled = restrictionsExist;
    const offboardingEnabled = readServerConfig(env, SERVER_CONFIG.AUTH_OFFBOARDING_ENABLED) ?? defaultOffboardingEnabled;
    const offboardingStrict = readServerConfig(env, SERVER_CONFIG.AUTH_OFFBOARDING_STRICT);
    const intervalSeconds = readServerConfig(env, SERVER_CONFIG.AUTH_OFFBOARDING_INTERVAL_SECONDS);
    const mode: AuthOffboardingMode = "per-request-cache";
    const signInService = resolveSignInServicePolicy(env, configurationErrors);
    const accountServicePresentation = resolveAccountServicePresentation(env, configurationErrors);

    return Object.freeze({
        anonymousSignupEnabled,
        signupProviders,
        requiredLoginProviders,
        signInService,
        accountServicePresentation,
        configurationErrors: Object.freeze(configurationErrors),
        offboarding: Object.freeze({
            enabled: offboardingEnabled,
            strict: offboardingStrict,
            intervalSeconds,
            mode,
        }),
    });
}
