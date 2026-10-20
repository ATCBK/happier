import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
    createApiRateLimitKeyGenerator,
    gateRateLimitConfig,
    resolveApiRateLimitPluginOptions,
    resolveApiTrustProxy,
    resolveRouteRateLimit,
} from "./apiRateLimitPolicy";

import { auth } from "@/app/auth/auth";

// Bearer keying is proven through the real auth owner (mint + verifyTokenForRoute).
// Only the storage boundary is stubbed: createToken/verify read the account
// token epoch and active status through db.account.findUnique, including transactions.
const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock } = await import("@/app/api/testkit/dbMocks");
    const db = {
        // PostgreSQL read-only transactions issue SET TRANSACTION READ ONLY at this DB boundary.
        $executeRaw: vi.fn(async () => 0),
        account: {
            findUnique: dbAccountFindUniqueMock,
        },
    };
    return { db: createDbTransactionMock(() => db).wrapDb(db) };
});
vi.mock("@/storage/prisma", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/prisma")>();
    const { createDbTransactionMock } = await import("@/app/api/testkit/dbMocks");
    const { db } = await import("@/storage/db");
    // SQLite read snapshots use a separate persistent connection boundary.
    return { ...actual, withSqliteReadSnapshot: createDbTransactionMock(() => db).readSnapshot };
});

const previousMasterSecret = process.env.HANDY_MASTER_SECRET;

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = "api-rate-limit-policy-spec-secret";
    dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active" });
    await auth.init();
});

afterAll(() => {
    if (typeof previousMasterSecret === "string") {
        process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    } else {
        delete process.env.HANDY_MASTER_SECRET;
    }
});

describe("apiRateLimitPolicy", () => {
    it("disables all rate limiting when HAPPIER_API_RATE_LIMITS_ENABLED=0", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "0",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "100",
            HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: "1 minute",
        } as const;

        expect(resolveApiRateLimitPluginOptions(env)).toEqual({ global: false });
        expect(
            resolveRouteRateLimit(env, {
                maxEnvKey: "HAPPIER_SESSION_MESSAGES_RATE_LIMIT_MAX",
                windowEnvKey: "HAPPIER_SESSION_MESSAGES_RATE_LIMIT_WINDOW",
                defaultMax: 600,
                defaultWindow: "1 minute",
            }),
        ).toBe(false);
    });

    it("enables global rate limiting when global max is set", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "123",
            HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: "30 seconds",
        } as const;

        expect(resolveApiRateLimitPluginOptions(env)).toEqual(
            expect.objectContaining({
                global: true,
                max: 123,
                timeWindow: "30 seconds",
                keyGenerator: expect.any(Function),
            }),
        );
    });

    it.each([
        { value: undefined, expected: "ip:203.0.113.9" },
        { value: "false", expected: "ip:203.0.113.9" },
        { value: "true", expected: "ip:198.51.100.7" },
    ])("preserves proxy keyword $value behavior", async ({ value, expected }) => {
        const app = Fastify({ trustProxy: resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: value }) });
        const key = createApiRateLimitKeyGenerator({}, { strategy: "ip-only" });
        app.get("/key", async (request) => ({
            key: await key(request),
            ips: request.ips,
            hostname: request.hostname,
            protocol: request.protocol,
        }));
        try {
            const response = await app.inject({ method: "GET", url: "/key", remoteAddress: "203.0.113.9", headers: {
                host: "origin.example",
                "x-forwarded-for": "198.51.100.7",
                "x-forwarded-host": "forwarded.example",
                "x-forwarded-proto": "https",
            } });
            expect(response.json()).toEqual({
                key: expected,
                ...(value === "true" ? { ips: ["203.0.113.9", "198.51.100.7"] } : {}),
                hostname: value === "true" ? "forwarded.example" : "origin.example",
                protocol: value === "true" ? "https" : "http",
            });
        } finally {
            await app.close();
        }
    });

    it("uses forwarded client details only when the connecting peer is a listed proxy", async () => {
        const app = Fastify({ trustProxy: resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "10.0.0.0/8, 127.0.0.1, ::1" }) });
        const keyGen = createApiRateLimitKeyGenerator({}, { strategy: "ip-only" });
        app.get("/key", async (request) => ({ key: await keyGen(request), host: request.host, protocol: request.protocol }));

        try {
            for (const remoteAddress of ["10.1.2.3", "127.0.0.1", "::1", "::ffff:10.1.2.3"]) {
                const res = await app.inject({
                    method: "GET", url: "/key", remoteAddress,
                    headers: { host: "origin.test", "x-forwarded-for": "198.51.100.7", "x-forwarded-host": "proxy.test", "x-forwarded-proto": "https" },
                });
                expect(res.json()).toEqual({ key: "ip:198.51.100.7", host: "proxy.test", protocol: "https" });
            }
            const direct = await app.inject({
                method: "GET", url: "/key", remoteAddress: "203.0.113.9",
                headers: { host: "origin.test", "x-forwarded-for": "198.51.100.7", "x-forwarded-host": "spoofed.test", "x-forwarded-proto": "https" },
            });
            expect(direct.json()).toEqual({ key: "ip:203.0.113.9", host: "origin.test", protocol: "http" });
            const chain = await app.inject({
                method: "GET", url: "/key", remoteAddress: "10.1.2.3",
                headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9, 10.2.3.4" },
            });
            expect(chain.json().key).toBe("ip:203.0.113.9");
        } finally {
            await app.close();
        }
    });

    it("rejects a HAPPIER_SERVER_TRUST_PROXY hop count instead of trusting nothing", () => {
        for (const hops of ["0", "1", "2"]) {
            expect(() => resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: hops })).toThrow(
                /HAPPIER_SERVER_TRUST_PROXY.*addresses or CIDRs/,
            );
        }
    });

    it("fails startup for an invalid proxy list instead of silently ignoring it", () => {
        expect(() => resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "10.0.0.0/8,invalid-proxy" })).toThrow();
    });

    it("keys an ordinary signed bearer by its verified account id (not by the raw Authorization header)", async () => {
        const token = await auth.createToken("rate-limit-account-1", undefined, {
            kind: "account",
            authority: "present_user",
        });
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("uid:rate-limit-account-1");
    });

    it("never keys a restricted account_directory bearer by its account id", async () => {
        const token = await auth.createToken("rate-limit-directory-1", undefined, {
            kind: "account_directory",
            authority: "present_user",
        });
        await expect(auth.verifyTokenForRoute(token)).resolves.toMatchObject({
            userId: "rate-limit-directory-1", authTokenKind: "account_directory",
        });
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
    });

    it("falls back to the ip key for an unverifiable bearer", async () => {
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: "Bearer not-a-signed-token" }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
    });

    it("uses the route IP key without pre-verifying a bearer on PAT-admitting routes", async () => {
        const verifySpy = vi.spyOn(auth, "verifyTokenForRoute");
        const keyGen = createApiRateLimitKeyGenerator({}, { strategy: "user-or-ip", scope: "global" });

        const key = await keyGen({
            headers: { authorization: "Bearer valid-token" },
            ip: "203.0.113.9",
            routeOptions: { config: { allowApiToken: true } },
        });

        expect(key).toBe("ip:203.0.113.9");
        expect(verifySpy).not.toHaveBeenCalled();
        verifySpy.mockRestore();
    });

    it("fails closed to the ip key without verifying absurdly large bearer tokens", async () => {
        const verifySpy = vi.spyOn(auth, "verifyTokenForRoute");

        const keyGen = createApiRateLimitKeyGenerator();
        const hugeToken = "x".repeat(5000);
        const key = await keyGen({ headers: { authorization: `Bearer ${hugeToken}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
        expect(verifySpy).not.toHaveBeenCalled();
        verifySpy.mockRestore();
    });

    it("truncates untrusted ip strings used in rate limit keys", async () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const hugeIp = "203.0.113.9," + "a".repeat(5000);
        const key = await keyGen({ headers: {}, ip: hugeIp });

        expect(key.startsWith("ip:")).toBe(true);
        expect(key.length).toBeLessThanOrEqual("ip:".length + 256);
    });

    it("fails closed to the ip key when the verified user id is excessively large", async () => {
        const userId = "x".repeat(129);
        const token = await auth.createToken(userId, undefined, {
            kind: "account", authority: "present_user",
        });
        // Reach the user-id guard, not the earlier bearer-size rejection.
        expect(token.length).toBeLessThanOrEqual(2048);
        await expect(auth.verifyTokenForRoute(token)).resolves.toMatchObject({ userId });

        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
    });

    it("can force ip-only keying strategy via env", async () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const key = await keyGen({ headers: { authorization: "Bearer valid-token" }, ip: "203.0.113.9" });
        expect(key).toBe("ip:203.0.113.9");
    });

    it("keeps scope-specific defaults and legacy strategy aliases with the real bearer verifier", async () => {
        const token = await auth.createToken("strategy-account", undefined, { kind: "account", authority: "present_user" });
        const request = { headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" };
        for (const scope of ["route", "global"] as const) {
            const key = scope === "global" ? "HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY" : "HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY";
            for (const value of ["default", "not-a-strategy"]) {
                expect(await createApiRateLimitKeyGenerator({ [key]: value }, { scope })(request)).toBe(scope === "global" ? "ip:203.0.113.9" : "uid:strategy-account");
            }
            expect(await createApiRateLimitKeyGenerator({ [key]: "ip_only" }, { scope })(request)).toBe("ip:203.0.113.9");
            expect(await createApiRateLimitKeyGenerator({ [key]: "userorip" }, { scope })(request)).toBe("uid:strategy-account");
        }
    });

    it("gates fixed route rate limits behind HAPPIER_API_RATE_LIMITS_ENABLED", () => {
        const enabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "1" } as const;
        const disabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "0" } as const;
        const config = { max: 10, timeWindow: "1 minute" } as const;

        expect(gateRateLimitConfig(enabledEnv, config)).toEqual(config);
        expect(gateRateLimitConfig(disabledEnv, config)).toBe(false);
    });
});
