import proxyAddr from '@fastify/proxy-addr';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { parseIntEnv } from "@/config/env";

import { API_RATE_LIMIT_GLOBAL_SERVER_CONFIG as RATE_LIMIT_CONFIG } from "./apiRateLimitDefaults";
import { auth } from "@/app/auth/auth";
import { isRestrictedAuthTokenKind } from "@/app/api/utils/apiTokenRouteAdmission";

export type ApiRateLimitRequest = Readonly<{
    ip?: unknown;
    headers?: Readonly<{ authorization?: unknown }>;
    routeOptions?: Readonly<{ config?: Readonly<{ allowApiToken?: unknown }> }>;
}>;

export type ApiRouteRateLimitConfig =
    | false
    | Readonly<{
          max: number;
          timeWindow: string;
          keyGenerator?: (request: ApiRateLimitRequest) => string | number | Promise<string | number>;
      }>;

export type ApiRateLimitKeyStrategy = "user-or-ip" | "ip-only";

const API_RATE_LIMIT_MAX_IP_KEY_LENGTH = 256;
const API_RATE_LIMIT_MAX_BEARER_TOKEN_LENGTH = 2048;
const API_RATE_LIMIT_MAX_USER_ID_LENGTH = 128;

function resolveApiRateLimitKeyStrategy(
    env: Record<string, string | undefined>,
    opts: { scope: "route" | "global" },
): ApiRateLimitKeyStrategy {
    const entry = opts.scope === "global"
        ? RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY
        : RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY;
    const raw = readServerConfig(env, entry);
    if (raw === "default") {
        return opts.scope === "global" ? "ip-only" : "user-or-ip";
    }
    return raw;
}

function resolveIpKey(request: ApiRateLimitRequest): string {
    const ip = typeof request?.ip === "string" ? request.ip.trim() : "";
    const safeIp = ip.length > API_RATE_LIMIT_MAX_IP_KEY_LENGTH ? ip.slice(0, API_RATE_LIMIT_MAX_IP_KEY_LENGTH) : ip;
    return safeIp ? `ip:${safeIp}` : "ip:unknown";
}

function parseBearerTokenFromRequest(request: ApiRateLimitRequest): string | null {
    const raw = request?.headers?.authorization;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase().startsWith("bearer ")) {
        const token = trimmed.slice(7).trim();
        if (!token) return null;
        if (token.length > API_RATE_LIMIT_MAX_BEARER_TOKEN_LENGTH) return null;
        return token;
    }
    return null;
}

export function createApiRateLimitKeyGenerator(
    env: Record<string, string | undefined> = {},
    opts?: Readonly<{ strategy?: ApiRateLimitKeyStrategy; scope?: "route" | "global" }>,
): (request: ApiRateLimitRequest) => Promise<string> {
    const strategy =
        opts?.strategy ??
        resolveApiRateLimitKeyStrategy(env, {
            scope: opts?.scope ?? "route",
        });

    return async (request) => {
        const ipKey = resolveIpKey(request);
        if (
            strategy === "ip-only"
            || request?.routeOptions?.config?.allowApiToken === true
        ) {
            return ipKey;
        }

        const token = parseBearerTokenFromRequest(request);
        if (!token) return ipKey;

        try {
            const verified = await auth.verifyTokenForRoute(token);
            if (isRestrictedAuthTokenKind(verified?.authTokenKind)) {
                return ipKey;
            }
            const userId = verified?.userId;
            if (typeof userId === "string") {
                const trimmed = userId.trim();
                if (trimmed.length > 0 && trimmed.length <= API_RATE_LIMIT_MAX_USER_ID_LENGTH) {
                    return `uid:${trimmed}`;
                }
            }
        } catch {
            // fail closed to IP
        }
        return ipKey;
    };
}

export function gateRateLimitConfig(
    env: Record<string, string | undefined>,
    rateLimit: ApiRouteRateLimitConfig,
): ApiRouteRateLimitConfig {
    const enabled = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_ENABLED);
    if (!enabled) return false;
    return rateLimit;
}

export function resolveApiRateLimitPluginOptions(
    env: Record<string, string | undefined>,
): Readonly<{ global: boolean; max?: number; timeWindow?: string; keyGenerator?: (request: ApiRateLimitRequest) => string | number | Promise<string | number> }> {
    const enabled = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_ENABLED);
    if (!enabled) {
        return { global: false };
    }

    const globalMax = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_GLOBAL_MAX);
    const timeWindow = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW);

    const keyGenerator = createApiRateLimitKeyGenerator(env, { scope: "global" });
    if (globalMax <= 0) {
        return { global: false, keyGenerator };
    }

    return { global: true, max: globalMax, timeWindow, keyGenerator };
}

export function resolveRouteRateLimit(
    env: Record<string, string | undefined>,
    params: Readonly<{
        maxEnvKey: string;
        windowEnvKey: string;
        defaultMax: number;
        defaultWindow: string;
        keyGenerator?: (request: ApiRateLimitRequest) => string | number | Promise<string | number>;
    }>,
): ApiRouteRateLimitConfig {
    const enabled = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_API_RATE_LIMITS_ENABLED);
    if (!enabled) return false;

    const maxRaw = env[params.maxEnvKey];
    const max = parseIntEnv(maxRaw, params.defaultMax, { min: 0 });
    if (max <= 0) return false;

    const windowRaw = (env[params.windowEnvKey] ?? "").trim();
    const timeWindow = windowRaw.length > 0 ? windowRaw : params.defaultWindow;

    return {
        max,
        timeWindow,
        ...(params.keyGenerator ? { keyGenerator: params.keyGenerator } : null),
    };
}

export type ApiProxyTrust = boolean | ((address: string, hop: number) => boolean);

export function resolveApiTrustProxy(env: Record<string, string | undefined>): ApiProxyTrust | undefined {
    const value = readServerConfig(env, RATE_LIMIT_CONFIG.HAPPIER_SERVER_TRUST_PROXY)?.trim();
    if (!value) return undefined;
    const keyword = value.toLowerCase();
    if (["true", "yes", "on"].includes(keyword)) return true;
    if (["false", "no", "off"].includes(keyword)) return false;
    if (/^\d+$/.test(value)) {
        throw new Error(
            `Invalid HAPPIER_SERVER_TRUST_PROXY: ${value}. Hop counts are not supported; ` +
                "list your proxies' addresses or CIDRs instead, comma-separated (for example 127.0.0.1 or 10.0.0.0/8).",
        );
    }
    return proxyAddr.compile(value.split(",").map((address) => address.trim()));
}
