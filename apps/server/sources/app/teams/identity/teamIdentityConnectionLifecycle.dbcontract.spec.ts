import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkOS } from "@workos-inc/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import { inTx, type Tx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { withAccountPublicationBeforeTransactionSql } from "@/app/changes/accountPublicationContention.testkit";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { createIdentityConnectionTestResult } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { setTeamMemberRoleForActorInTx } from "../memberships/memberAdministration";
import { createTeamIdentityConnectionInTx, setTeamIdentityConnectionEnabledInTx } from "./teamIdentityConnectionLifecycle";
import {
    preflightTeamIdentityConnectionRemovalForActor,
    createTeamIdentityConnectionForActor,
    updateTeamIdentityConnectionSettingsForActor,
    consumeTeamIdentityConnectionTestForActor,
    setTeamIdentityConnectionEnabledForActor,
    startTeamIdentityConnectionTestForActor,
} from "./teamIdentityConnectionAdministration";
import {
    createTeamWorkosAdminPortalLink,
    createTeamWorkosConnection,
    reconcileTeamWorkosConnection,
    setTeamWorkosConnection,
} from "./teamWorkosAdministration";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .toString()
        .trim()
        .toLowerCase();

    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported contract provider: ${raw}`);
}

describe("TeamIdentityConnection lifecycle database contract", () => {
    const provider = resolveContractProviderFromEnv();
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for db contract tests).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterAll(async () => {
        if (!dbConnected) return;
        await db.$disconnect();
    });

    async function administrativeConnection() {
        const suffix = randomUUID();
        const actor = await db.account.create({ data: {} });
        const member = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: `Admission preflight ${suffix}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: actor.id, role: TeamRole.owner, status: TeamMembershipStatus.active },
            { teamId: team.id, accountId: member.id, role: TeamRole.member, status: TeamMembershipStatus.active },
        ] });
        const identityProvider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id,
            kind: "workos_sso",
            displayName: "Admission company identity",
            enabled: true,
            config: { v: 1, kind: "workos_sso" },
        } });
        const created = await inTx(tx => createTeamIdentityConnectionInTx(tx, {
            teamId: team.id,
            providerInstanceId: identityProvider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: `org_${suffix}`, connectionId: `conn_${suffix}` },
            settings: { v: 1, kind: "workos_sso" },
            createdByAccountId: actor.id,
        }));
        if (created.status !== "created") throw new Error(`Connection fixture was ${created.status}`);
        return {
            actor,
            member,
            connection: created.connection,
            input: {
                v: 1 as const,
                teamId: team.id,
                actorAccountId: actor.id,
                connectionId: created.connection.id,
                expectedRevision: created.connection.revision,
                env: {},
                authenticationAuthority: "present_user" as const,
            },
        };
    }

    it.skipIf(provider !== "postgres").each([
        "create", "settings", "disable", "test", "enable", "portal", "missing", "reconcile", "select", "draft",
    ] as const)("commits %s after a concurrent Account cursor advance before exclusive admission", async operation => {
        const { actor, connection, input } = await administrativeConnection();
        const env = { WORKOS_API_KEY: "sk_test_cursor", WORKOS_CLIENT_ID: "client_cursor",
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_WEBAPP_URL: "https://app.example.test" };
        const reference = connection.externalReference;
        if (reference.kind !== "workos_sso") throw new Error("Expected WorkOS fixture");
        const upstream = { id: reference.connectionId, organizationId: reference.organizationId,
            name: "Cursor company", type: "SAML", state: "active" };
        // Only the third-party SDK boundary is substituted; adapters, policy,
        // lifecycle, admission, publication and PostgreSQL remain real.
        const client = {
            organizations: { getOrganizationByExternalId: async () => ({ id: "org_created", name: "Company" }) },
            adminPortal: { generateLink: async () => ({ link: "https://setup.workos.test/cursor" }) },
            sso: { getConnection: async () => upstream,
                listConnections: async () => ({ data: operation === "missing" ? [] : [upstream], listMetadata: { after: null } }) },
        } as unknown as WorkOS;
        const dependencies = { resolvePlatform: () => ({ available: true as const, clientId: env.WORKOS_CLIENT_ID,
            client, runtimeFingerprint: "workos-platform:v1:cursor" }), resolveServerIdentityId: async () => "srv_cursor" };
        if (operation === "disable") await db.teamIdentityConnection.update({ where: { id: connection.id }, data: { enabled: true } });
        if (operation === "portal") await db.teamIdentityConnection.update({ where: { id: connection.id },
            data: { externalReference: { ...reference, organizationId: null, connectionId: null } } });
        if (operation === "create") await db.teamIdentityConnection.delete({ where: { id: connection.id } });
        const runtime = operation === "test" ? await resolveOAuthRuntimeById(env, connection.providerInstanceId,
            { kind: "team", teamId: input.teamId }, "identity_connection_test") : null;
        if (operation === "test" && !runtime) throw new Error("Expected test runtime");
        const testResult = runtime ? await createIdentityConnectionTestResult({ initiatorAccountId: actor.id,
            securityBinding: { purpose: "identity_connection_test", provider: runtime.reference,
                connection: { id: connection.id, revision: connection.revision }, admission: null },
            providerUserId: "cursor_subject", testedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }) : null;
        // Every attempt crosses a real cursor advance after its audience
        // capture, before taking its first exclusive Account lock.
        const { result, advances } = await withAccountPublicationBeforeTransactionSql(actor.id,
            sql => sql.includes('FROM "Account"') && sql.endsWith("FOR UPDATE"), async () => {
            const current = { ...input, env };
            return operation === "draft"
                ? await createTeamWorkosConnection(current, dependencies)
                : operation === "create"
                ? await createTeamIdentityConnectionForActor({ ...current, providerInstanceId: connection.providerInstanceId,
                    externalReference: reference, settings: { v: 1, kind: "workos_sso" } })
                : operation === "settings"
                    ? await updateTeamIdentityConnectionSettingsForActor({ ...current, settings: { v: 1, kind: "workos_sso" } })
                    : operation === "disable" || operation === "enable"
                        ? await setTeamIdentityConnectionEnabledForActor({ ...current, enabled: operation === "enable" }, dependencies)
                        : operation === "test"
                            ? await consumeTeamIdentityConnectionTestForActor({ ...current, resultHandle: testResult!.resultHandle })
                            : operation === "portal"
                                ? await createTeamWorkosAdminPortalLink({ ...current, intent: "sso" }, dependencies)
                                : operation === "select"
                                    ? await setTeamWorkosConnection({ ...current, workosConnectionId: reference.connectionId! }, dependencies)
                                    : await reconcileTeamWorkosConnection(current, dependencies);
        });
        const current = { ...input, env };
        expect(result).toMatchObject({ ok: true });
        expect(advances).toBeGreaterThan(0);
        const persisted = await db.teamIdentityConnection.findFirstOrThrow({ where: {
            teamId: input.teamId, providerInstanceId: connection.providerInstanceId,
        } });
        if (operation === "enable" || operation === "disable") expect(persisted.enabled).toBe(operation === "enable");
        if (operation === "create") expect(await db.teamIdentityConnection.count({ where: {
            teamId: input.teamId, providerInstanceId: connection.providerInstanceId,
        } })).toBe(1);
        if (operation === "portal") expect(persisted.externalReference).toMatchObject({ organizationId: "org_created" });
        if (operation === "missing" || operation === "reconcile" || operation === "select" || operation === "enable") {
            expect(persisted.lastObservation).toMatchObject({ presentation: {
                status: operation === "missing" ? "missing" : "active",
            } });
        }
        if (operation === "settings") {
            await expect(updateTeamIdentityConnectionSettingsForActor({ ...current, settings: { v: 1, kind: "workos_sso" } }))
                .resolves.toMatchObject({ ok: false, error: "identity_connection_conflict" });
        }
        if (operation === "test") {
            expect(persisted.lastSuccessfulTestAt).not.toBeNull();
            await expect(consumeTeamIdentityConnectionTestForActor({ ...current, resultHandle: testResult!.resultHandle }))
                .resolves.toMatchObject({ ok: false, error: "identity_connection_test_invalid" });
        }
    });

    it.skipIf(provider !== "postgres")("rechecks an unbound WorkOS candidate that became an activated namespace before admission", async () => {
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: `WorkOS candidate ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: TeamRole.owner } });
        const candidate = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", displayName: "Unbound candidate", enabled: true,
            firstEnabledAt: new Date(), config: { v: 1, kind: "workos_sso" },
        } });
        const original = db.$transaction;
        const peerScope = new AsyncLocalStorage<boolean>();
        let captured = false;
        let activatedConnectionId: string | undefined;
        // Observe the actual database read, then commit the canonical competing
        // lifecycle before this caller acquires its existing Account cohort.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                if (property !== "identityProviderInstance") return Reflect.get(owner, property, proxyReceiver);
                return new Proxy(owner.identityProviderInstance, { get(model, method, modelReceiver) {
                    if (method !== "findFirst") return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: unknown[]) => {
                        const value: unknown = await Reflect.apply(model.findFirst, model, queryArgs);
                        if (!captured && typeof value === "object" && value !== null && "id" in value && value.id === candidate.id) {
                            captured = true;
                            await peerScope.run(true, () => inTx(async peer => {
                                const created = await createTeamIdentityConnectionInTx(peer, {
                                    teamId: team.id, providerInstanceId: candidate.id, createdByAccountId: actor.id,
                                    externalReference: { v: 1, kind: "workos_sso", organizationId: "org_activated", connectionId: "conn_activated" },
                                    settings: { v: 1, kind: "workos_sso" },
                                });
                                if (created.status !== "created") throw new Error(`Competing connection was ${created.status}`);
                                const enabled = await setTeamIdentityConnectionEnabledInTx(peer, {
                                    teamId: team.id, id: created.connection.id, expectedRevision: created.connection.revision, enabled: true,
                                });
                                expect(enabled.status).toBe("applied");
                                activatedConnectionId = created.connection.id;
                            }));
                        }
                        return value;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await createTeamWorkosConnection({ v: 1, teamId: team.id, actorAccountId: actor.id,
                authenticationAuthority: "present_user", env: { WORKOS_API_KEY: "sk_test_candidate", WORKOS_CLIENT_ID: "client_candidate" } }, { resolvePlatform: () => ({
                    // Draft creation only checks platform availability; no SDK method is invoked.
                    available: true, clientId: "client_candidate", client: {} as WorkOS, runtimeFingerprint: "workos-platform:v1:candidate",
                }) });
            expect(captured).toBe(true);
            expect(result).toMatchObject({ ok: true, value: { state: "setting_up" } });
            if (!result.ok) throw new Error(result.error);
            if (!activatedConnectionId) throw new Error("Competing namespace was not activated");
            expect(result.value.id).not.toBe(activatedConnectionId);
            expect(await db.teamIdentityConnection.count({ where: { teamId: team.id } })).toBe(2);
            expect(await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: activatedConnectionId } }))
                .toMatchObject({ enabled: true, externalReference: { connectionId: "conn_activated" } });
        } finally { db.$transaction = original; }
    });

    /** PostgreSQL decides whether the real owner can finish behind an ordinary content holder. */
    async function commitOrBlock(tx: Tx, operation: () => Promise<unknown>, pending: Promise<unknown>[]) {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        let settled = false;
        const competitor = operation().finally(() => { settled = true; });
        void competitor.catch(() => undefined);
        pending.push(competitor);
        while (!settled) {
            const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            if (blocked) return;
        }
        await competitor;
    }

    it.skipIf(provider !== "postgres")("rechecks current administration authority after waiting for exclusive Account admission", async () => {
        const { actor, member, connection, input } = await administrativeConnection();
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: input.teamId, accountId: member.id } },
            data: { role: TeamRole.owner } });
        const actorMembership = await db.teamMembership.findUniqueOrThrow({ where: {
            teamId_accountId: { teamId: input.teamId, accountId: actor.id },
        } });
        const pending: Promise<unknown>[] = [];
        let outcome: Awaited<ReturnType<typeof updateTeamIdentityConnectionSettingsForActor>> | undefined;
        try {
            await inTx(async holder => {
                await acquireAccountSessionOwnerMetadataFenceInTx(holder, actor.id, "content");
                await commitOrBlock(holder, async () => {
                    outcome = await updateTeamIdentityConnectionSettingsForActor({ ...input,
                        settings: { v: 1, kind: "workos_sso" } });
                }, pending);
                expect(outcome).toBeUndefined();
                const demoted = await inTx(tx => setTeamMemberRoleForActorInTx(tx, {
                    teamId: input.teamId, actorAccountId: member.id, membershipId: actorMembership.id,
                    role: TeamRole.member, authentication: { authenticationAuthority: "present_user" },
                }));
                expect(demoted).toMatchObject({ ok: true });
            });
            await Promise.all(pending);
            expect(outcome).toMatchObject({ ok: false, error: "team_forbidden" });
            expect(await db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.id } }))
                .toMatchObject({ revision: connection.revision });
        } finally { await Promise.allSettled(pending); }
    });

    it.skipIf(provider !== "postgres").each([
        "removal preview", "test start", "enable validation", "WorkOS portal", "WorkOS reconcile", "WorkOS selection",
    ] as const)("admits the read-only %s preflight alongside ordinary Account content", async operation => {
        const { actor, input } = await administrativeConnection();
        const pending: Promise<unknown>[] = [];
        const unavailablePlatform = {
            resolvePlatform: () => ({ available: false as const, code: "workos_platform_unavailable" as const, reason: "not_configured" as const }),
        };
        const run = async () => {
            if (operation === "removal preview") {
                await expect(preflightTeamIdentityConnectionRemovalForActor(input)).resolves.toMatchObject({ ok: true });
            } else if (operation === "test start") {
                await expect(startTeamIdentityConnectionTestForActor(input)).resolves.toMatchObject({ ok: false, error: "identity_provider_unavailable" });
            } else if (operation === "enable validation") {
                await expect(setTeamIdentityConnectionEnabledForActor({ ...input, enabled: true })).resolves.toMatchObject({ ok: false, error: "identity_provider_unavailable" });
            } else if (operation === "WorkOS portal") {
                await expect(createTeamWorkosAdminPortalLink({ ...input, intent: "sso" }, unavailablePlatform)).resolves.toMatchObject({ ok: false, error: "workos_platform_unavailable" });
            } else if (operation === "WorkOS reconcile") {
                await expect(reconcileTeamWorkosConnection(input, unavailablePlatform)).resolves.toMatchObject({ ok: false, error: "workos_platform_unavailable" });
            } else {
                await expect(setTeamWorkosConnection({ ...input, workosConnectionId: "conn_selected" }, unavailablePlatform)).resolves.toMatchObject({ ok: false, error: "workos_platform_unavailable" });
            }
        };
        let completed = false;
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, actor.id, "content");
                await commitOrBlock(tx, async () => { await run(); completed = true; }, pending);
                expect(completed, "A read-only admin preflight must not acquire an exclusive Account fence").toBe(true);
            });
        } finally { await Promise.allSettled(pending); }
    });

    it.skipIf(provider !== "postgres")("keeps changed connection security excluded while retaining administrator-only preflight authority", async () => {
        const { actor, member, connection, input } = await administrativeConnection();
        await expect(preflightTeamIdentityConnectionRemovalForActor({ ...input, actorAccountId: member.id })).resolves.toMatchObject({ ok: false, error: "team_forbidden" });
        await expect(preflightTeamIdentityConnectionRemovalForActor({ ...input, actorAccountId: member.id, teamId: null })).resolves.toMatchObject({ ok: false, error: "home_forbidden" });
        await db.teamIdentityConnection.update({ where: { id: connection.id }, data: { enabled: true } });
        const pending: Promise<unknown>[] = [];
        let completed = false;
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, actor.id, "content");
                await commitOrBlock(tx, async () => {
                    await expect(setTeamIdentityConnectionEnabledForActor({ ...input, enabled: false })).resolves.toMatchObject({ ok: true });
                    completed = true;
                }, pending);
                expect(completed, "A changed connection must still enter with exclusive Account admission").toBe(false);
            });
            await Promise.all(pending);
            expect(completed).toBe(true);
            await expect(db.teamIdentityConnection.findUniqueOrThrow({ where: { id: connection.id } })).resolves.toMatchObject({ enabled: false });
        } finally { await Promise.allSettled(pending); }
    });

    it("observes an existing exact binding without poisoning the duplicate-create transaction", async () => {
        const suffix = randomUUID();
        const team = await db.team.create({ data: { name: `Identity contract ${suffix}` } });
        const identityProvider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "workos_sso",
                displayName: "Company identity",
                enabled: true,
                firstEnabledAt: new Date("2026-09-09T00:00:00.000Z"),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const input = {
            teamId: team.id,
            providerInstanceId: identityProvider.id,
            externalReference: {
                v: 1 as const,
                kind: "workos_sso" as const,
                organizationId: `org_${suffix}`,
                connectionId: `conn_${suffix}`,
            },
            settings: { v: 1 as const, kind: "workos_sso" as const },
            createdByAccountId: null,
        };

        const created = await inTx(async (tx) => await createTeamIdentityConnectionInTx(tx, input));
        expect(created.status).toBe("created");
        if (created.status !== "created") return;

        await expect(inTx(async (tx) => await createTeamIdentityConnectionInTx(tx, input))).resolves.toMatchObject({
            status: "already_exists",
            connection: { id: created.connection.id },
        });
        const [racingLeft, racingRight] = await Promise.all([
            inTx(async (tx) => await createTeamIdentityConnectionInTx(tx, input)),
            inTx(async (tx) => await createTeamIdentityConnectionInTx(tx, input)),
        ]);
        expect([racingLeft, racingRight]).toEqual([
            expect.objectContaining({ status: "already_exists", connection: expect.objectContaining({ id: created.connection.id }) }),
            expect.objectContaining({ status: "already_exists", connection: expect.objectContaining({ id: created.connection.id }) }),
        ]);
        await expect(db.teamIdentityConnection.count({
            where: { teamId: team.id, providerInstanceId: identityProvider.id },
        })).resolves.toBe(1);
    });

    it("serializes concurrent WorkOS creation onto one provider and one connection", async () => {
        const suffix = randomUUID();
        const actor = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: `Concurrent WorkOS ${suffix}` } });
        await db.teamMembership.create({
            data: {
                teamId: team.id,
                accountId: actor.id,
                role: TeamRole.owner,
                status: TeamMembershipStatus.active,
            },
        });
        const input = {
            v: 1 as const,
            actorAccountId: actor.id,
            teamId: team.id,
            env: {},
            authenticationAuthority: "present_user" as const,
        };
        const dependencies = {
            resolvePlatform: () => ({
                available: true as const,
                clientId: "client_exact",
                client: {} as never,
                runtimeFingerprint: "workos-platform:v1:exact",
            }),
        };

        const [first, second] = await Promise.all([
            createTeamWorkosConnection(input, dependencies),
            createTeamWorkosConnection(input, dependencies),
        ]);
        expect(first).toEqual(second);
        expect(first.ok).toBe(true);
        await expect(db.identityProviderInstance.count({
            where: { ownerTeamId: team.id, kind: "workos_sso" },
        })).resolves.toBe(1);
        await expect(db.teamIdentityConnection.count({
            where: { teamId: team.id, providerInstance: { kind: "workos_sso" } },
        })).resolves.toBe(1);
    });
});
