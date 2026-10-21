import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";

function applyAccountUsernameFriendsEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1",
        ...overrides,
    });
}

describe("Account username update (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-username-", initAuth: false });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.releasedUsername.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("checks normalized availability and only suggests policy-valid free names", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async (app) => {
            const owner = await db.account.create({ data: { publicKey: "pk-username-check" } });
            await db.account.create({ data: { publicKey: "pk-username-check-taken", username: "alice" } });
            const headers = { "x-test-user-id": owner.id };
            const response = await app.inject({ method: "POST", url: "/v1/account/username/check", headers, payload: { username: " ALICE " } });
            expect(response.statusCode).toBe(200);
            const checked = response.json();
            expect(checked).toMatchObject({ username: "alice", availability: "unavailable" });
            expect(new Set(checked.suggestions).size).toBe(2);
            for (const username of checked.suggestions) {
                const candidate = await app.inject({ method: "POST", url: "/v1/account/username/check", headers, payload: { username } });
                expect(candidate.json()).toEqual({ username, availability: "available", suggestions: [] });
            }
            const reserved = await app.inject({ method: "POST", url: "/v1/account/username/check", headers, payload: { username: "support" } });
            expect(reserved.json()).toEqual({ username: "support", availability: "reserved", suggestions: [] });
        });
    });

    it("releases once and denies reclaim by every Account during the thirty-day hold", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async (app) => {
            const owner = await db.account.create({ data: { publicKey: "pk-username-release", username: "release_me" } });
            const other = await db.account.create({ data: { publicKey: "pk-username-release-other" } });
            const release = () => app.inject({ method: "POST", url: "/v1/account/username/release", headers: { "x-test-user-id": owner.id }, payload: {} });
            const before = Date.now();
            const response = await release();
            expect(response.statusCode).toBe(200);
            const result = response.json();
            expect(result).toMatchObject({ username: null, released: true });
            expect(result.reservedUntilMs).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
            expect((await release()).json()).toEqual({ username: null, released: false, reservedUntilMs: null });
            for (const accountId of [owner.id, other.id]) {
                const claim = await app.inject({ method: "POST", url: "/v1/account/username", headers: { "x-test-user-id": accountId }, payload: { username: "release_me" } });
                expect(claim.statusCode).toBe(409);
                expect(claim.json()).toEqual({ error: "username-taken" });
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).username).toBeNull();
        });
    });

    it("retains an existing reserved name but rejects a new reserved acquisition", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async (app) => {
            const retained = await db.account.create({ data: { publicKey: "pk-username-retained", username: "support" } });
            const other = await db.account.create({ data: { publicKey: "pk-username-reserved-new" } });
            const keep = await app.inject({ method: "POST", url: "/v1/account/username", headers: { "x-test-user-id": retained.id }, payload: { username: " SUPPORT " } });
            expect(keep.statusCode).toBe(200);
            const acquire = await app.inject({ method: "POST", url: "/v1/account/username", headers: { "x-test-user-id": other.id }, payload: { username: "admin" } });
            expect(acquire.statusCode).toBe(400);
            expect(acquire.json()).toEqual({ error: "invalid-username" });
        });
    });

    it("uses the configured candidate grammar and reports fewer suggestions when candidates collide", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const owner = await db.account.create({ data: { publicKey: "pk-username-candidates" } });
            await db.account.create({ data: { publicKey: "pk-username-candidates-base", username: "alice" } });
            await db.account.create({ data: { publicKey: "pk-username-candidates-one", username: "alice1" } });
            const check = () => app.inject({ method: "POST", url: "/v1/account/username/check", headers: { "x-test-user-id": owner.id }, payload: { username: "alice" } });
            expect((await check()).json()).toEqual({ username: "alice", availability: "unavailable", suggestions: ["alice2"] });
            applyAccountUsernameFriendsEnv(harness, { FRIENDS_USERNAME_REGEX: "^[a-z]+$" });
            expect((await check()).json()).toEqual({ username: "alice", availability: "unavailable", suggestions: [] });
        });
    });

    it("admits an expired hold exactly at its boundary and never holds a rename", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const owner = await db.account.create({ data: { publicKey: "pk-username-expiry", username: "before_rename" } });
            const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
            await db.releasedUsername.create({ data: { username: "expired_name", expiresAt: new Date(expiresAt) } });
            const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt - 1);
            const claim = () => app.inject({ method: "POST", url: "/v1/account/username", headers: { "x-test-user-id": owner.id }, payload: { username: "expired_name" } });
            try {
                expect((await claim()).statusCode).toBe(409);
                now.mockReturnValue(expiresAt);
                expect((await claim()).statusCode).toBe(200);
                expect(await db.releasedUsername.findUnique({ where: { username: "before_rename" } })).toBeNull();
                expect(await db.account.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ username: "expired_name", usernameAutoFillEnabled: false });
            } finally { now.mockRestore(); }
        });
    });

    it("rejects caller-supplied identity authority on check and release", async () => {
        applyAccountUsernameFriendsEnv(harness);
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const owner = await db.account.create({ data: { publicKey: "pk-username-authority", username: "authority_name" } });
            for (const [operation, payload] of [
                ["check", { username: "authority_name", kind: "account_replacement" }],
                ["release", { kind: "identity_unlink" }],
            ] as const) {
                const response = await app.inject({ method: "POST", url: `/v1/account/username/${operation}`, headers: { "x-test-user-id": owner.id }, payload });
                expect(response.statusCode).toBe(400);
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).username).toBe("authority_name");
            expect(await db.releasedUsername.count()).toBe(0);
        });
    });

    it("POST /v1/account/username sets the current user's username", async () => {
        applyAccountUsernameFriendsEnv(harness);

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "alice" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ username: "alice" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe("alice");
            },
        );
    });

    it("POST /v1/account/username returns 409 username-taken when the username is already used", async () => {
        applyAccountUsernameFriendsEnv(harness);

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const taken = "alice_taken";
                await db.account.create({
                    data: { publicKey: "pk-username-taken-u1", username: taken },
                    select: { id: true },
                });
                const u2 = await db.account.create({
                    data: { publicKey: "pk-username-taken-u2" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u2.id,
                    },
                    payload: { username: taken },
                });

                expect(res.statusCode).toBe(409);
                expect(res.json()).toEqual({ error: "username-taken" });
            },
        );
    });

    it("POST /v1/account/username returns 400 invalid-username for invalid usernames", async () => {
        applyAccountUsernameFriendsEnv(harness);

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-invalid-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "A!!" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "invalid-username" });
            },
        );
    });

    it("POST /v1/account/username returns 400 username-disabled when username updates are disabled", async () => {
        applyAccountUsernameFriendsEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: "test_client_id",
            GITHUB_CLIENT_SECRET: "test_client_secret",
            GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-disabled-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "someone" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "username-disabled" });
            },
        );
    });

    it("POST /v1/account/username returns 400 friends-disabled when Friends requires GitHub but GitHub OAuth is not configured", async () => {
        applyAccountUsernameFriendsEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: undefined,
            GITHUB_CLIENT_SECRET: undefined,
            GITHUB_REDIRECT_URL: undefined,
            GITHUB_REDIRECT_URI: undefined,
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-gh-unconfigured-u1" },
                    select: { id: true },
                });
                await db.accountIdentity.create({
                    data: {
                        accountId: u1.id,
                        provider: "github",
                        providerUserId: "1",
                        providerLogin: "login1",
                        profile: {
                            id: 1,
                            login: "login1",
                            avatar_url: "https://example.test/avatar.png",
                            name: null,
                        } as any,
                    },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "chosen_name" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "friends-disabled" });
            },
        );
    });

    it("POST /v1/account/username allows setting a username when Friends requires GitHub and the user has GitHub connected", async () => {
        applyAccountUsernameFriendsEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: "test_client_id",
            GITHUB_CLIENT_SECRET: "test_client_secret",
            GITHUB_REDIRECT_URL: "https://api.example.test/v1/oauth/github/callback",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-gh-required-u1" },
                    select: { id: true },
                });
                await db.accountIdentity.create({
                    data: {
                        accountId: u1.id,
                        provider: "github",
                        providerUserId: "1",
                        providerLogin: "taken_login",
                        profile: {
                            id: 1,
                            login: "taken_login",
                            avatar_url: "https://example.test/avatar.png",
                            name: null,
                        } as any,
                    },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "chosen_name" },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ username: "chosen_name" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe("chosen_name");
            },
        );
    });

    it("POST /v1/account/username returns 400 friends-disabled when Friends requires an unregistered identity provider", async () => {
        applyAccountUsernameFriendsEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: "custom",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-custom-required-u1" },
                    select: { id: true },
                });
                await db.accountIdentity.create({
                    data: {
                        accountId: u1.id,
                        provider: "custom",
                        providerUserId: "1",
                        providerLogin: "someone",
                        profile: { id: 1, login: "someone" } as any,
                    },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "chosen_custom" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "friends-disabled" });

                const dbUser = await db.account.findUnique({ where: { id: u1.id }, select: { username: true } });
                expect(dbUser?.username).toBe(null);
            },
        );
    });

    it("POST /v1/account/username returns 400 friends-disabled when friends feature is off", async () => {
        applyAccountUsernameFriendsEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
        });

        await withAuthenticatedTestApp(
            (app) => accountRoutes(app as any),
            async (app) => {
                const u1 = await db.account.create({
                    data: { publicKey: "pk-username-friends-disabled-u1" },
                    select: { id: true },
                });

                const res = await app.inject({
                    method: "POST",
                    url: "/v1/account/username",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": u1.id,
                    },
                    payload: { username: "someone_else" },
                });

                expect(res.statusCode).toBe(400);
                expect(res.json()).toEqual({ error: "friends-disabled" });
            },
        );
    });
});
