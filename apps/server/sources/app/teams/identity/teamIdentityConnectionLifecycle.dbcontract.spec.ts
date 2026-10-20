import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import { inTx, type Tx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { createTeamIdentityConnectionInTx } from "./teamIdentityConnectionLifecycle";
import {
    preflightTeamIdentityConnectionRemovalForActor,
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
