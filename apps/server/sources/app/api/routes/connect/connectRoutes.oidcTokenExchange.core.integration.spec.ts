import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { connectRoutes } from "./connectRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { startOidcStubServer, type OidcStubServer } from "../../testkit/oidcStub";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

const DEVBOX_CLIENT_ID = "devbox_client";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    enableAuthentication(typed);
    return trackApp(typed);
}

describe("connectRoutes (OIDC token exchange) (integration)", () => {
    let harness: LightSqliteHarness;
    let oidcStub: OidcStubServer;
    let onUserInfoRequest: (() => Promise<void>) | undefined;

    function providerEnv(tokenExchange?: Record<string, unknown>): NodeJS.ProcessEnv {
        return {
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "plaintext_only",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "1",
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "acme",
            AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([
                {
                    id: "acme",
                    type: "oidc",
                    displayName: "Acme IdP",
                    issuer: oidcStub.issuer,
                    clientId: "oidc_client",
                    clientSecret: "oidc_secret",
                    redirectUrl: "https://api.example.test/v1/oauth/acme/callback",
                    ...(tokenExchange ? { tokenExchange } : {}),
                },
            ]),
        };
    }

    async function seedLinkedAccount(params: { providerUserId: string; encryptionMode?: "plain" | "e2ee" }) {
        const encryptionMode = params.encryptionMode ?? "plain";
        const account = await db.account.create({
            data: { publicKey: encryptionMode === "e2ee" ? "pk_hex_1" : null, encryptionMode },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "acme",
                providerUserId: params.providerUserId,
                providerLogin: "alice",
                profile: { sub: params.providerUserId, preferred_username: "alice" },
            },
        });
        return account.id;
    }

    async function exchange(accessToken: string) {
        const app = createTestApp();
        connectRoutes(app);
        await app.ready();
        return app.inject({
            method: "POST",
            url: "/v1/auth/external/acme/token-exchange",
            headers: { "content-type": "application/json" },
            payload: { accessToken },
        });
    }

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-token-exchange-",
            initAuth: true,
            initEncrypt: true,
        });
        oidcStub = await startOidcStubServer({ includeUserInfoEndpoint: true, onUserInfoRequest: () => onUserInfoRequest?.() });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        oidcStub.reset();
        onUserInfoRequest = undefined;
        await db.repeatKey.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
        await oidcStub.close();
    });

    it("refuses exchange before UserInfo when build policy denies keyless accounts", async () => {
        harness.resetEnv({
            ...providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }),
            HAPPIER_BUILD_FEATURES_DENY: "e2ee.keylessAccounts",
        });
        await seedLinkedAccount({ providerUserId: "user_1" });
        let userInfoRequests = 0;
        onUserInfoRequest = async () => { userInfoRequests += 1; };
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "token-exchange-disabled" });
        expect(userInfoRequests).toBe(0);
    });

    it("returns a token for the linked account when the access token was issued to an allowed client", async () => {
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }));
        const accountId = await seedLinkedAccount({ providerUserId: "user_1" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(200);
        const body = res.json() as { success: boolean; token: string };
        expect(body.success).toBe(true);
        expect(await auth.verifyToken(body.token)).toMatchObject({
            userId: accountId,
            authority: "present_user",
            authenticationEvidence: [{ kind: "provider", providerId: "acme", identityId: expect.any(String), runtimeFingerprint: expect.any(String) }],
        });
    });

    it("reads the client and subject from configured claim names", async () => {
        // Shape of an IdP whose access tokens carry the client in `cid`, the user id in
        // `uid`, and the login in `sub`, while /userinfo reports the user id as `sub`.
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID], clientIdClaim: "cid", subjectClaim: "uid" }));
        const accountId = await seedLinkedAccount({ providerUserId: "00u_1" });
        const accessToken = oidcStub.issueAccessToken(
            { sub: "alice@example.test", uid: "00u_1", cid: DEVBOX_CLIENT_ID },
            { sub: "00u_1" },
        );

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(200);
        expect(await auth.verifyToken((res.json() as { token: string }).token)).toMatchObject({ userId: accountId });
    });

    it("refuses an access token issued to a client that is not allowed", async () => {
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }));
        await seedLinkedAccount({ providerUserId: "user_1" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: "some_other_app" }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "client-not-allowed" });
    });

    it("refuses issuance when the configured client allowlist changes during upstream verification", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happier-token-exchange-config-"));
        const configPath = join(directory, "providers.json");
        try {
            const original = providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] });
            await writeFile(configPath, original.AUTH_PROVIDERS_CONFIG_JSON!);
            harness.resetEnv({ ...original, AUTH_PROVIDERS_CONFIG_PATH: configPath });
            await seedLinkedAccount({ providerUserId: "user_1" });
            const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });
            onUserInfoRequest = async () => {
                const updated = providerEnv({ allowedClientIds: ["replacement-client"] });
                await writeFile(configPath, updated.AUTH_PROVIDERS_CONFIG_JSON!);
            };

            const res = await exchange(accessToken);

            expect(res.statusCode).toBe(409);
            expect(res.json()).toEqual({ error: "auth_provider_configuration_changed" });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("refuses a token whose client claim was edited after signing", async () => {
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }));
        await seedLinkedAccount({ providerUserId: "user_1" });
        const issued = oidcStub.issueAccessToken({ sub: "user_1", client_id: "some_other_app" }, { sub: "user_1" });
        const [header, payload, signature] = issued.split(".");
        const claims = JSON.parse(new TextDecoder().decode(privacyKit.decodeBase64(payload!, "base64url"))) as Record<string, unknown>;
        const forgedPayload = privacyKit.encodeBase64(new TextEncoder().encode(JSON.stringify({ ...claims, client_id: DEVBOX_CLIENT_ID })), "base64url").replace(/=+$/, "");

        const res = await exchange(`${header}.${forgedPayload}.${signature}`);

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid-token" });
    });

    it("refuses a token whose subject does not match the userinfo subject", async () => {
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }));
        await seedLinkedAccount({ providerUserId: "user_1" });
        await seedLinkedAccount({ providerUserId: "user_2" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_2", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "invalid-token" });
    });

    it("never creates an account for an identity that is not linked yet", async () => {
        harness.resetEnv({
            ...providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }),
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "1",
        });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not-linked" });
        expect(await db.account.count()).toBe(0);
        expect(await db.accountIdentity.count()).toBe(0);
    });

    it("is off for a provider without an allowed client list", async () => {
        harness.resetEnv(providerEnv());
        await seedLinkedAccount({ providerUserId: "user_1" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "token-exchange-disabled" });
    });

    it("is off when keyless login is not enabled for the provider", async () => {
        harness.resetEnv({
            ...providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }),
            HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "github",
        });
        await seedLinkedAccount({ providerUserId: "user_1" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "token-exchange-disabled" });
    });

    it("refuses an account that fails login eligibility", async () => {
        harness.resetEnv(providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }));
        const accountId = await seedLinkedAccount({ providerUserId: "user_1" });
        await db.account.update({ where: { id: accountId }, data: { status: "suspended" } });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "account-disabled" });
    });

    it("requires a restore for an end-to-end encrypted account", async () => {
        harness.resetEnv({
            ...providerEnv({ allowedClientIds: [DEVBOX_CLIENT_ID] }),
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        });
        await seedLinkedAccount({ providerUserId: "user_1", encryptionMode: "e2ee" });
        const accessToken = oidcStub.issueAccessToken({ sub: "user_1", client_id: DEVBOX_CLIENT_ID }, { sub: "user_1" });

        const res = await exchange(accessToken);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "restore-required" });
    });
});
