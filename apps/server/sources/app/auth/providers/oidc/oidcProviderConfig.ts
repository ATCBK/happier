import { readFileSync } from "node:fs";
import { readHomeConfigValueSource } from "@/app/home/settings/homeConfigProvenance";
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

export type OidcAuthProviderInstanceConfig = Readonly<{
    id: string;
    type: "oidc";
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    /** Explicit after parsing; legacy deployment input is normalized to client_secret_post. */
    clientAuthenticationMethod: "client_secret_post" | "client_secret_basic";
    redirectUrl: string;
    scopes: string;
    httpTimeoutSeconds: number;
    claims: Readonly<{
        login: string;
        email: string;
        groups: string;
    }>;
    allow: Readonly<{
        usersAllowlist: readonly string[];
        emailDomains: readonly string[];
        groupsAny: readonly string[];
        groupsAll: readonly string[];
    }>;
    fetchUserInfo: boolean;
    storeRefreshToken: boolean;
    /** External bearer exchange is opt-in; managed providers omit this setting. */
    tokenExchange?: OidcTokenExchangeConfig | null;
    ui: Readonly<{
        buttonColor: string | null;
        iconHint: string | null;
    }>;
}>;

export type OidcTokenExchangeConfig = Readonly<{
    allowedClientIds: readonly string[];
    clientIdClaim: string | null;
    subjectClaim: string;
}>;

export type ResolveAuthProviderInstancesResult = Readonly<{
    instances: readonly OidcAuthProviderInstanceConfig[];
    errors: readonly string[];
}>;

function readConfigFromPath(path: string): { raw: string } | { error: string } {
    try {
        const raw = readFileSync(path, "utf8");
        return { raw };
    } catch {
        return { error: `Invalid AUTH_PROVIDERS_CONFIG_PATH: cannot read file` };
    }
}

function normalizeProviderId(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const normalized = input.trim().toLowerCase();
    if (!normalized) return null;
    return normalized;
}

function expectString(value: unknown, field: string, errors: string[]): string | null {
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`Invalid ${field}: expected non-empty string`);
        return null;
    }
    return value;
}

/**
 * A literal `clientSecret` wins. Otherwise `clientSecretEnv` names the environment variable that holds the
 * secret, so provider config can live in non-secret deployment values while the secret comes from a secret store.
 * An unset or empty variable is a config error, like a missing literal secret.
 */
function resolveClientSecret(
    record: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
    providerId: string,
    errors: string[],
): string | null {
    if (record.clientSecret !== undefined || record.clientSecretEnv === undefined) {
        return expectString(record.clientSecret, `clientSecret for ${providerId}`, errors);
    }

    const envName = expectString(record.clientSecretEnv, `clientSecretEnv for ${providerId}`, errors)?.trim();
    if (!envName) return null;

    const configKey = (env.AUTH_PROVIDERS_CONFIG_PATH ?? "").trim()
        ? "AUTH_PROVIDERS_CONFIG_PATH"
        : "AUTH_PROVIDERS_CONFIG_JSON";
    if (readHomeConfigValueSource(env, configKey) !== "deployment") {
        errors.push(`Invalid clientSecretEnv for ${providerId}: environment references require deployment-authored provider configuration`);
        return null;
    }

    const value = env[envName];
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`Invalid clientSecretEnv for ${providerId}: environment variable ${envName} is unset or empty`);
        return null;
    }
    return value;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return fallback;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function parseClientAuthenticationMethod(
    value: unknown,
    providerId: string,
    errors: string[],
): OidcAuthProviderInstanceConfig["clientAuthenticationMethod"] | null {
    if (value === undefined) return "client_secret_post";
    if (value === "client_secret_post" || value === "client_secret_basic") return value;
    errors.push(`Invalid clientAuthenticationMethod for ${providerId}: expected "client_secret_post" or "client_secret_basic"`);
    return null;
}

function validateIssuerUrl(issuer: string, providerId: string, errors: string[]): boolean {
    let url: URL;
    try {
        url = new URL(issuer);
    } catch {
        errors.push(`Invalid issuer for ${providerId}: must be a valid URL`);
        return false;
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol === "https:") return true;
    if (protocol === "http:" && isLoopbackHostname(url.hostname)) return true;

    errors.push(`Invalid issuer for ${providerId}: must be https:// (or http://localhost for local testing)`);
    return false;
}

function parseScopes(raw: unknown, errors: string[], providerId: string): string | null {
    const fallback = "openid profile email";
    const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
    const scopes = value
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const normalized = scopes.filter((s) => {
        const v = s.toLowerCase();
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
    });
    if (!normalized.some((s) => s.toLowerCase() === "openid")) {
        errors.push(`Invalid scopes for ${providerId}: must include "openid"`);
        return null;
    }
    return normalized.join(" ");
}

function parseClaimName(raw: unknown, fallback: string): string {
    if (typeof raw !== "string") return fallback;
    const trimmed = raw.trim();
    return trimmed ? trimmed : fallback;
}

function parseClaims(raw: unknown): OidcAuthProviderInstanceConfig["claims"] {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return Object.freeze({
        login: parseClaimName(record.login, "preferred_username"),
        email: parseClaimName(record.email, "email"),
        groups: parseClaimName(record.groups, "groups"),
    });
}

function parseStringList(
    raw: unknown,
    field: string,
    providerId: string,
    errors: string[],
): string[] | null {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        errors.push(`Invalid ${field} for ${providerId}: expected an array of strings`);
        return null;
    }
    const out: string[] = [];
    for (const value of raw) {
        if (typeof value !== "string") {
            errors.push(`Invalid ${field} for ${providerId}: expected an array of strings`);
            return null;
        }
        const trimmed = value.trim();
        if (!trimmed) continue;
        out.push(trimmed);
    }
    return out;
}

/** Comparison keys only: never use this normalization for the opaque OIDC subject. */
export function normalizeOidcAllowRules(allow: OidcAuthProviderInstanceConfig["allow"]) {
    const normalizeIds = (values: readonly string[]) => values.map((value) => value.trim().toLowerCase()).filter(Boolean);
    return {
        usersAllowlist: normalizeIds(allow.usersAllowlist),
        emailDomains: normalizeIds(allow.emailDomains)
            .map((value) => value.startsWith("@") ? value.slice(1) : value)
            .filter(Boolean),
        groupsAny: normalizeIds(allow.groupsAny),
        groupsAll: normalizeIds(allow.groupsAll),
    };
}

function parseAllow(
    raw: unknown,
    providerId: string,
    errors: string[],
): OidcAuthProviderInstanceConfig["allow"] | null {
    if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
        errors.push(`Invalid allow for ${providerId}: expected object`);
        return null;
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    const usersAllowlist = parseStringList(record.usersAllowlist, "allow.usersAllowlist", providerId, errors);
    const emailDomains = parseStringList(record.emailDomains, "allow.emailDomains", providerId, errors);
    const groupsAny = parseStringList(record.groupsAny, "allow.groupsAny", providerId, errors);
    const groupsAll = parseStringList(record.groupsAll, "allow.groupsAll", providerId, errors);
    if (!usersAllowlist || !emailDomains || !groupsAny || !groupsAll) return null;
    const normalized = normalizeOidcAllowRules({ usersAllowlist, emailDomains, groupsAny, groupsAll });
    return Object.freeze({
        usersAllowlist: Object.freeze(normalized.usersAllowlist),
        emailDomains: Object.freeze(normalized.emailDomains),
        groupsAny: Object.freeze(normalized.groupsAny),
        groupsAll: Object.freeze(normalized.groupsAll),
    });
}

function parseTokenExchange(raw: unknown, providerId: string): OidcTokenExchangeConfig | null {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    // A malformed opt-in disables exchange without disabling ordinary provider login.
    const allowedClientIds = parseStringList(record.allowedClientIds, "tokenExchange.allowedClientIds", providerId, []);
    if (!allowedClientIds || allowedClientIds.length === 0) return null;
    return Object.freeze({
        allowedClientIds: Object.freeze(allowedClientIds),
        clientIdClaim: typeof record.clientIdClaim === "string" && record.clientIdClaim.trim()
            ? record.clientIdClaim.trim() : null,
        subjectClaim: parseClaimName(record.subjectClaim, "sub"),
    });
}

function parseUi(raw: unknown): OidcAuthProviderInstanceConfig["ui"] {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const buttonColor =
        typeof record.buttonColor === "string" && record.buttonColor.trim() ? record.buttonColor.trim() : null;
    const iconHint = typeof record.iconHint === "string" && record.iconHint.trim() ? record.iconHint.trim() : null;
    return Object.freeze({ buttonColor, iconHint });
}

function parseHttpTimeoutSeconds(raw: unknown): number {
    const fallback = 30;
    const max = 120;

    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
    if (!Number.isFinite(num)) return fallback;
    const clamped = Math.max(1, Math.min(max, Math.floor(num)));
    return clamped;
}

export function resolveAuthProviderInstancesFromEnv(env: NodeJS.ProcessEnv): ResolveAuthProviderInstancesResult {
    const configPath = (env.AUTH_PROVIDERS_CONFIG_PATH ?? "").toString().trim();
    const rawFromPath = configPath ? readConfigFromPath(configPath) : null;
    const raw =
        rawFromPath && "raw" in rawFromPath
            ? rawFromPath.raw
            : (env.AUTH_PROVIDERS_CONFIG_JSON ?? "");

    if (rawFromPath && "error" in rawFromPath) {
        return { instances: [], errors: [rawFromPath.error] };
    }

    if (!raw) return { instances: [], errors: [] };

    const errors: string[] = [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { instances: [], errors: ["Invalid AUTH_PROVIDERS_CONFIG_JSON: must be valid JSON"] };
    }

    if (!Array.isArray(parsed)) {
        return { instances: [], errors: ["Invalid AUTH_PROVIDERS_CONFIG_JSON: must be a JSON array"] };
    }

    const instances: OidcAuthProviderInstanceConfig[] = [];
    const idCounts = new Map<string, number>();
    for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) continue;
        const normalizedId = normalizeProviderId((entry as Record<string, unknown>).id);
        if (!normalizedId) continue;
        idCounts.set(normalizedId, (idCounts.get(normalizedId) ?? 0) + 1);
    }
    const duplicateIds = new Set(
        [...idCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([id]) => id),
    );
    const reportedDuplicateIds = new Set<string>();

    for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) {
            errors.push("Invalid provider entry: expected object");
            continue;
        }
        const record = entry as Record<string, unknown>;

        const normalizedId = normalizeProviderId(record.id);
        if (!normalizedId) {
            errors.push("Invalid id: expected non-empty string");
            continue;
        }
        if (duplicateIds.has(normalizedId)) {
            if (!reportedDuplicateIds.has(normalizedId)) {
                errors.push(`Duplicate provider id: ${normalizedId}`);
                reportedDuplicateIds.add(normalizedId);
            }
            continue;
        }

        const type = record.type;
        if (type !== "oidc") {
            errors.push(`Invalid type for ${normalizedId}: expected "oidc"`);
            continue;
        }

        const entryErrors: string[] = [];
        const displayName = expectString(record.displayName, `displayName for ${normalizedId}`, entryErrors);
        const issuer = expectString(record.issuer, `issuer for ${normalizedId}`, entryErrors);
        const clientId = expectString(record.clientId, `clientId for ${normalizedId}`, entryErrors);
        const clientSecret = resolveClientSecret(record, env, normalizedId, entryErrors);
        const redirectUrl = expectString(record.redirectUrl, `redirectUrl for ${normalizedId}`, entryErrors);

        if (!displayName || !issuer || !clientId || !clientSecret || !redirectUrl) {
            errors.push(...entryErrors);
            continue;
        }
        if (!validateIssuerUrl(issuer, normalizedId, entryErrors)) {
            errors.push(...entryErrors);
            continue;
        }

        const scopes = parseScopes(record.scopes, entryErrors, normalizedId);
        const clientAuthenticationMethod = parseClientAuthenticationMethod(
            record.clientAuthenticationMethod,
            normalizedId,
            entryErrors,
        );
        if (!scopes || !clientAuthenticationMethod) {
            errors.push(...entryErrors);
            continue;
        }

        const httpTimeoutSeconds = parseHttpTimeoutSeconds(record.httpTimeoutSeconds);
        const claims = parseClaims(record.claims);
        const allow = parseAllow(record.allow, normalizedId, entryErrors);
        if (!allow) {
            errors.push(...entryErrors);
            continue;
        }
        const fetchUserInfo = parseBoolean(record.fetchUserInfo, false);
        const storeRefreshToken = parseBoolean(record.storeRefreshToken, false);
        const tokenExchange = parseTokenExchange(record.tokenExchange, normalizedId);
        const ui = parseUi(record.ui);

        instances.push({
            id: normalizedId,
            type: "oidc",
            displayName,
            issuer,
            clientId,
            clientSecret,
            clientAuthenticationMethod,
            redirectUrl,
            scopes,
            httpTimeoutSeconds,
            claims,
            allow,
            fetchUserInfo,
            storeRefreshToken,
            tokenExchange,
            ui,
        });
    }

    return { instances, errors };
}
