import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it, vi, afterEach } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { userRoutes } from "./userRoutes";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { UsersSearchResponseSchema } from "@happier-dev/protocol";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return trackApp(typed);
}

function applyFriendsRouteEnv(
    harness: LightSqliteHarness,
    overrides: Record<string, string | undefined> = {},
): void {
    harness.resetEnv({
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "1",
        ...overrides,
    });
}

describe("Friends + GitHub gating (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-friends-github-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.repeatKey.deleteMany().catch(() => {});
        await db.accountIdentity.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("POST /v1/friends/add returns 404 not_found when friends feature is off", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-disabled-u1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-disabled-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("GET /v1/user/search returns 404 not_found when friends feature is off", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-disabled-current" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=ali",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("GET /v1/friends returns 404 not_found when friends feature is off", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-friends-list-disabled-current" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/friends",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("POST /v1/friends/remove returns 404 not_found when friends feature is off", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-friends-remove-disabled-current", username: "remove_disabled_current" },
            select: { id: true },
        });
        const other = await db.account.create({
            data: { publicKey: "pk-friends-remove-disabled-other", username: "remove_disabled_other" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/remove",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": current.id,
            },
            payload: { uid: other.id },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "not_found" });
        await app.close();
    });

    it("POST /v1/friends/add returns 400 provider-required when either user lacks the required identity provider", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "1",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: "test_client_id",
            GITHUB_CLIENT_SECRET: "test_client_secret",
            GITHUB_REDIRECT_URL: "https://app.example.test/oauth/github/callback",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-u1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "provider-required", provider: "github" });
        await app.close();
    });

    it("POST /v1/friends/add returns 400 username-required when username-based friends are enabled and either user lacks a username", async () => {
        applyFriendsRouteEnv(harness);

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const u1 = await db.account.create({
            data: { publicKey: "pk-friends-username-required-u1", username: "u_name_1" },
            select: { id: true },
        });
        const u2 = await db.account.create({
            data: { publicKey: "pk-friends-username-required-u2" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "POST",
            url: "/v1/friends/add",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": u1.id,
            },
            payload: { uid: u2.id },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "username-required" });
        await app.close();
    });

    it("GET /v1/user/search returns only users connected to the required identity provider", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: "test_client_id",
            GITHUB_CLIENT_SECRET: "test_client_secret",
            GITHUB_REDIRECT_URL: "https://app.example.test/oauth/github/callback",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-current" },
            select: { id: true },
        });

        const ghUser = await db.account.create({
            data: {
                publicKey: "pk-search-gh",
                username: "ghonly_alice",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: ghUser.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "ghonly_alice",
                profile: { login: "ghonly_alice" } as any,
            },
            select: { id: true },
        });

        await db.account.create({
            data: {
                publicKey: "pk-search-nogh",
                username: "ghonly_alicia",
            },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=ghonly_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id)).toEqual([ghUser.id]);
        await app.close();
    });

    it("GET /v1/user/search returns username accounts even without GitHub when username-based friends are enabled", async () => {
        applyFriendsRouteEnv(harness);

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-usernames-current" },
            select: { id: true },
        });

        const usernameOnly = await db.account.create({
            data: {
                publicKey: "pk-search-usernames-nogh",
                username: "allowuser_alicia_username_only",
            },
            select: { id: true },
        });

        const ghUser = await db.account.create({
            data: {
                publicKey: "pk-search-usernames-gh",
                username: "allowuser_alice2",
            },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=allowuser_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id).sort()).toEqual([ghUser.id, usernameOnly.id].sort());
        await app.close();
    });

    it("GET /v1/user/search collaboration discovery remains independent of social gating and excludes arbitrary Accounts", async () => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0",
            HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: "0",
            GITHUB_CLIENT_ID: "test_client_id",
            GITHUB_CLIENT_SECRET: "test_client_secret",
            GITHUB_REDIRECT_URL: "https://app.example.test/oauth/github/callback",
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const actor = await db.account.create({
            data: { publicKey: "pk-collaboration-actor", username: "collaboration_actor" },
            select: { id: true },
        });
        const friend = await db.account.create({
            data: { publicKey: "pk-collaboration-friend", username: "collaboration_friend" },
            select: { id: true },
        });
        const teammate = await db.account.create({
            data: { publicKey: "pk-collaboration-teammate", username: "collaboration_teammate" },
            select: { id: true },
        });
        const outsider = await db.account.create({
            data: { publicKey: "pk-collaboration-outsider", username: "collaboration_outsider" },
            select: { id: true },
        });
        await db.userRelationship.create({
            data: { fromUserId: friend.id, toUserId: actor.id, status: "friend" },
        });
        const team = await db.team.create({ data: { name: "Collaboration Team" }, select: { id: true } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: actor.id, role: "member" },
            { teamId: team.id, accountId: teammate.id, role: "member" },
        ] });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=collaboration_&purpose=collaboration",
            headers: { "x-test-user-id": actor.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((user) => user.id).sort()).toEqual([friend.id, teammate.id].sort());
        expect(body.users.map((user) => user.id)).not.toContain(outsider.id);
        await app.close();
    });

    it("finds freshly named Team colleagues without usernames and pages their canonical names", async () => {
        applyFriendsRouteEnv(harness, { HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: "0" });
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();
        const actor = await db.account.create({ data: { publicKey: "pk-name-search-actor" } });
        const team = await db.team.create({ data: { name: "Design" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "member" } });
        const colleagues = await Promise.all(Array.from({ length: 11 }, async (_, index) => {
            const account = await db.account.create({ data: {
                publicKey: `pk-name-search-${index}`, name: "Previous name", firstName: "Stale", lastName: "Identity",
            } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: "member" } });
            return await db.account.update({ where: { id: account.id }, data: { name: "Noah Patel" } });
        }));
        const outsider = await db.account.create({ data: { publicKey: "pk-name-search-outsider", name: "Noah Outside" } });
        const search = async (query: string, cursor?: string) => {
            const response = await app.inject({ method: "GET", headers: { "x-test-user-id": actor.id },
                url: `/v1/user/search?${new URLSearchParams({ query, purpose: "collaboration", ...(cursor ? { cursor } : {}) })}` });
            expect(response.statusCode).toBe(200);
            // The registered route serializes its real DB output into the exact UI consumer schema.
            return UsersSearchResponseSchema.parse(response.json());
        };
        const first = await search("noah");
        expect(first.users).toHaveLength(10);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await search("noah", first.nextCursor!);
        expect(second.users).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        const people = [...first.users, ...second.users];
        expect(new Set(people.map((user) => user.id))).toEqual(new Set(colleagues.map((account) => account.id)));
        expect(people.every((user) => user.name === "Noah Patel")).toBe(true);
        expect(people.some((user) => user.id === outsider.id)).toBe(false);
        expect((await search("Stale")).users).toEqual([]);
        await app.close();
    });

    it("pages every matching username with an opaque continuation instead of hiding the eleventh Account", async () => {
        applyFriendsRouteEnv(harness);

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-pagination-current", username: "search_pagination_current" },
            select: { id: true },
        });
        const matches = await Promise.all(Array.from({ length: 11 }, async (_, index) => await db.account.create({
            data: {
                publicKey: `pk-search-pagination-${index}`,
                username: `paged_candidate_${String(index).padStart(2, "0")}`,
            },
            select: { id: true, username: true },
        })));

        const first = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=paged_candidate_",
            headers: { "x-test-user-id": current.id },
        });
        expect(first.statusCode).toBe(200);
        const firstBody = first.json() as { users: Array<{ id: string }>; nextCursor: string | null };
        expect(firstBody.users).toHaveLength(10);
        expect(firstBody.nextCursor).toEqual(expect.any(String));

        const second = await app.inject({
            method: "GET",
            url: `/v1/user/search?${new URLSearchParams({ query: "paged_candidate_", cursor: firstBody.nextCursor! })}`,
            headers: { "x-test-user-id": current.id },
        });
        expect(second.statusCode).toBe(200);
        const secondBody = second.json() as { users: Array<{ id: string }>; nextCursor: string | null };
        expect(secondBody.users.map((user) => user.id)).toEqual([matches[10]!.id]);
        expect(secondBody.nextCursor).toBeNull();
        expect(new Set([...firstBody.users.map((user) => user.id), ...secondBody.users.map((user) => user.id)]))
            .toEqual(new Set(matches.map((match) => match.id)));

        const wrongQuery = await app.inject({
            method: "GET",
            url: `/v1/user/search?${new URLSearchParams({ query: "different_candidate_", cursor: firstBody.nextCursor! })}`,
            headers: { "x-test-user-id": current.id },
        });
        expect(wrongQuery.statusCode).toBe(400);
        expect(wrongQuery.json()).toEqual({ error: "invalid_cursor" });

        await app.close();
    });

    it.each([undefined, "mysql"])("GET /v1/user/search uses portable prefix filters with provider %s", async (provider) => {
        applyFriendsRouteEnv(harness, {
            HAPPIER_SERVER_FLAVOR: "light",
            HAPPY_SERVER_FLAVOR: "light",
            // SQLite rejects the same unsupported `mode` argument as MySQL.
            // This does not substitute for the real MySQL DB-contract lane.
            HAPPIER_DB_PROVIDER: provider,
            HAPPY_DB_PROVIDER: undefined,
        });

        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const current = await db.account.create({
            data: { publicKey: "pk-search-light-default-current", username: "light_default_current" },
            select: { id: true },
        });

        const match = await db.account.create({
            data: { publicKey: "pk-search-light-default-match", username: "lightdefault_alice" },
            select: { id: true },
        });

        await db.account.create({
            data: { publicKey: "pk-search-light-default-other", username: "otherprefix_bob" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: "/v1/user/search?query=lightdefault_",
            headers: { "x-test-user-id": current.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as { users: Array<{ id: string }> };
        expect(body.users.map((u) => u.id)).toContain(match.id);
        await app.close();
    });
});
