import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { prepareExternalActionResponseEnvelopeV1 } from "@happier-dev/protocol/actions";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import type { ExternalActionDaemonDispatcher } from "@/app/api/socket/externalActionDispatcher";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerExternalActionRoutes } from "./registerExternalActionRoutes";

function dispatchedResponse(response: unknown) {
    return {
        kind: "response" as const,
        prepared: prepareExternalActionResponseEnvelopeV1(response),
    };
}

function createTestApp(
    dispatch: ExternalActionDaemonDispatcher,
    configure?: (app: AppFastify) => void,
): AppFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    configure?.(typed);
    registerExternalActionRoutes(typed, { dispatch });
    return typed;
}

describe("registerExternalActionRoutes (API-token provenance) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-action-pat-provenance-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("relays only the request-local PAT principal and refuses it after revocation", async () => {
        const account = await db.account.create({
            data: { publicKey: "external-action-pat-provenance" },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "External Action request-local provenance",
            expiresAt: new Date("2030-08-22T12:01:00.000Z"),
        });
        const received = {
            request: null as Parameters<ExternalActionDaemonDispatcher>[0] | null,
        };
        const dispatch: ExternalActionDaemonDispatcher = async (request) => {
            received.request = request;
            return dispatchedResponse({
                v: 1,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true, result: { accepted: true } },
            });
        };
        const app = createTestApp(dispatch);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, requestId: "one-verify", input: {} },
            });

            expect(response.statusCode).toBe(200);
            expect(received.request).toEqual({
                actionId: "session.spawn_new",
                envelope: { v: 1, requestId: "one-verify", input: {} },
                principal: {
                    accountId: account.id,
                    principalId: account.id,
                    credentialId: pat.tokenId,
                    authority: "account_automation",
                    grant: API_TOKEN_FULL_GRANT_V1,
                },
            });
            const relayed = received.request;
            if (!relayed) throw new Error("Expected the authenticated request to reach the daemon relay");
            expect(relayed.principal).not.toHaveProperty("expiresAt");
            expect(JSON.stringify(relayed).includes(pat.token)).toBe(false);
            expect(await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId })).toMatchObject({ revoked: true });
            received.request = null;
            const revokedResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, requestId: "after-revocation", input: {} },
            });
            expect(revokedResponse.statusCode).toBe(401);
            expect(revokedResponse.json()).toEqual({ error: "invalid_token" });
            expect(received.request).toBeNull();
        } finally {
            await app.close();
        }
    });

    it("keeps the Action-owned limiter and PAT principal under global user-or-ip limiting", async () => {
        const account = await db.account.create({
            data: { publicKey: "external-action-global-rate-limit" },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "External Action global rate limiter",
        });
        const dispatch = vi.fn<ExternalActionDaemonDispatcher>(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: { ok: true as const, result: { accepted: true } },
        }));
        const rawApp = Fastify({ logger: false });
        await rawApp.register(fastifyRateLimit, resolveApiRateLimitPluginOptions({
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "100",
            HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: "user-or-ip",
        }));
        rawApp.setValidatorCompiler(validatorCompiler);
        rawApp.setSerializerCompiler(serializerCompiler);
        const app = rawApp.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch });
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(200);
            // The Action route owns its limiter even under a different global strategy.
            expect(response.headers["x-ratelimit-limit"]).toBe("600");
            expect(dispatch).toHaveBeenCalledOnce();
            expect(dispatch.mock.calls[0]?.[0].principal).toEqual({
                accountId: account.id,
                principalId: account.id,
                credentialId: pat.tokenId,
                authority: "account_automation",
                grant: API_TOKEN_FULL_GRANT_V1,
            });
        } finally {
            await app.close();
        }
    });

    it("rejects missing, invalid, and non-PAT credentials before the JSON parser", async () => {
        const account = await db.account.create({
            data: { publicKey: "external-action-on-request-admission" },
            select: { id: true },
        });
        const signedToken = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const parse = vi.fn();
        const dispatch = vi.fn(async () => dispatchedResponse({
            v: 1 as const,
            actionId: "session.spawn_new" as const,
            execution: { ok: true as const, result: { accepted: true } },
        }));
        const app = createTestApp(dispatch, (configured) => {
            configured.removeContentTypeParser("application/json");
            configured.addContentTypeParser(
                "application/json",
                { parseAs: "string" },
                (_request, body, done) => {
                    parse();
                    done(null, { received: body });
                },
            );
        });
        await app.ready();

        try {
            for (const headers of [
                {},
                { authorization: "Bearer not-a-valid-token" },
                { authorization: `Bearer ${signedToken}` },
            ]) {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/actions/session.spawn_new",
                    headers: {
                        ...headers,
                        "content-type": "application/json",
                    },
                    payload: "{not-json",
                });

                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }

            expect(parse).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});
