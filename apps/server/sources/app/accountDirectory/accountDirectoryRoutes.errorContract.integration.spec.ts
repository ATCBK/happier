import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/mini";

import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import type { Fastify as AppFastify } from "@/app/api/types";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import {
    AccountDirectoryRouteErrorResponseV1Schema,
    createHomeCredentialDestinationDigestV1,
} from "@happier-dev/protocol";

import { registerAccountDirectoryRoutes, registerHomeLoginRoute } from "./accountDirectoryRoutes";

const envSnapshot = snapshotEnv();

const HOME_DESCRIPTOR = {
    v: 1 as const,
    homeServerIdentityId: "srv_home",
    canonicalServerUrl: "https://home.example.test",
    revision: 1,
    endpoints: [{ kind: "https" as const, url: "https://home.example.test" }],
};

const ASSERTION = {
    v: 1 as const,
    purpose: "happier.home-login" as const,
    issuerServerIdentityId: "srv_account_service",
    issuerSubjectId: "account-1",
    audienceHomeServerIdentityId: "srv_home",
    credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(HOME_DESCRIPTOR),
    clientBoxPublicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    issuedAtMs: 1_700_000_000_000,
    expiresAtMs: 1_700_000_180_000,
    keyId: "a".repeat(64),
    signatureBase64Url: "A".repeat(86),
};

async function createTestApp(
    registerRoutes: (app: AppFastify) => void,
    authenticate: (() => Promise<void>) | null = async () => {},
): Promise<AppFastify> {
    const app = Fastify({ logger: false });
    await app.register(fastifyRateLimit, resolveApiRateLimitPluginOptions(process.env));
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    if (authenticate) typed.decorate("authenticate", authenticate);
    else enableAuthentication(typed);
    enableErrorHandlers(typed);
    registerRoutes(typed);
    return typed;
}

afterEach(() => {
    restoreEnv(envSnapshot);
});

describe("Account Directory route error contract", () => {
    it("returns the strict Directory error schema for missing connection authentication", async () => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp(registerAccountDirectoryRoutes, null);
        try {
            const response = await app.inject({ method: "GET", url: "/v1/account-directory/me" });
            expect(response.statusCode).toBe(401);
            expect(AccountDirectoryRouteErrorResponseV1Schema.parse(response.json())).toEqual({
                error: "invalid_token",
            });
        } finally {
            await app.close();
        }
    });

    it.each([
        ["unsupported version", { v: 2, assertion: ASSERTION }],
        ["unknown field", { v: 1, assertion: ASSERTION, unexpected: true }],
    ])("normalizes malformed Home-login bodies with an %s", async (_case, payload) => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp(registerHomeLoginRoute);
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/home-login",
                payload,
            });

            expect(response.statusCode).toBe(400);
            expect(AccountDirectoryRouteErrorResponseV1Schema.parse(response.json())).toEqual({
                error: "invalid_request",
            });
        } finally {
            await app.close();
        }
    });

    it("normalizes malformed Account Directory path parameters", async () => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp(registerAccountDirectoryRoutes);
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account-directory/homes/%20/login-assertion",
                payload: {
                    v: 1,
                    homeServerIdentityId: "srv_home",
                    clientBoxPublicKeyBase64: ASSERTION.clientBoxPublicKeyBase64,
                },
            });

            expect(response.statusCode).toBe(400);
            expect(AccountDirectoryRouteErrorResponseV1Schema.parse(response.json())).toEqual({
                error: "invalid_request",
            });
        } finally {
            await app.close();
        }
    });

    it("normalizes malformed JSON before it reaches Home-login validation", async () => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp(registerHomeLoginRoute);
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/home-login",
                headers: { "content-type": "application/json" },
                payload: '{"v":',
            });

            expect(response.statusCode).toBe(400);
            expect(AccountDirectoryRouteErrorResponseV1Schema.parse(response.json())).toEqual({
                error: "invalid_request",
            });
        } finally {
            await app.close();
        }
    });

    it("normalizes the route rate-limit response without adding retry metadata", async () => {
        applyEnvValues({
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_ACCOUNT_DIRECTORY_ASSERTION_REDEEM_RATE_LIMIT_MAX: "1",
            HAPPIER_ACCOUNT_DIRECTORY_ASSERTION_REDEEM_RATE_LIMIT_WINDOW: "1 minute",
        });
        const app = await createTestApp(registerHomeLoginRoute);
        try {
            const request = {
                method: "POST" as const,
                url: "/v1/auth/home-login",
                payload: { v: 2, assertion: ASSERTION },
            };
            expect((await app.inject(request)).statusCode).toBe(400);

            const response = await app.inject(request);
            expect(response.statusCode).toBe(429);
            expect(AccountDirectoryRouteErrorResponseV1Schema.parse(response.json())).toEqual({
                error: "rate_limited",
            });
        } finally {
            await app.close();
        }
    });

    it("leaves ordinary route validation on the existing global error contract", async () => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp((typed) => {
            typed.post("/ordinary", {
                schema: {
                    body: z.strictObject({ value: z.string().check(z.minLength(1)) }),
                },
            }, async () => ({ ok: true }));
        });
        try {
            const response = await app.inject({
                method: "POST",
                url: "/ordinary",
                payload: { value: "" },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "invalid-params" });
        } finally {
            await app.close();
        }
    });

    it("delegates unrecognized Directory failures to the existing global error handler", async () => {
        applyEnvValues({ HAPPIER_API_RATE_LIMITS_ENABLED: "0" });
        const app = await createTestApp(registerAccountDirectoryRoutes, async () => {
            throw new Error("must not reach the response");
        });
        try {
            const response = await app.inject({
                method: "GET",
                url: "/v1/account-directory/me",
            });

            expect(response.statusCode).toBe(500);
            expect(response.json()).toEqual({
                error: "Internal Server Error",
                message: "An unexpected error occurred",
                statusCode: 500,
            });
        } finally {
            await app.close();
        }
    });
});
