import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { withAccountPublicationBeforeTransactionSql } from "@/app/changes/accountPublicationContention.testkit";
import {
    claimDirectorySourceFullReconcile,
    claimWorkosDirectorySourceIncremental,
    removeDirectorySourceForObservedDeletion,
    requestDirectorySourceSync,
} from "./directorySourceService";
import { setDirectorySourcePausedForActor, syncDirectorySourceForActor } from "./directorySourceAdministration";
import { completeDirectoryProjection } from "./directoryProjectionRepository";
import { applyExternalTeamMembershipInTx } from "../memberships/externalFacts";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Directory source currentness (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        await db.homeGovernancePolicy.upsert({ where: { id: "home" }, create: { id: "home" }, update: {} });
    });
    afterAll(async () => { await db.$disconnect(); });

    async function fixture() {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Source currentness ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", enabled: true, displayName: "Directory provider",
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_currentness", connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id, teamIdentityConnectionId: connection.id, kind: "workos_directory", state: "active",
            displayName: "Directory", externalSourceKey: randomUUID(), eventCursor: "event_before",
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_currentness" },
            lastAttemptAt: new Date("2026-10-01T10:00:00Z"),
        } });
        return { actor, team, source };
    }

    /** Interleave a committed peer at the real source SELECT boundary; all domain logic remains real. */
    async function afterSourceRead<T>(sourceId: string, peer: () => Promise<void>, run: () => Promise<T>, forceReadCommitted: boolean,
        method: "findUnique" | "findFirst" = "findUnique") {
        const original = db.$transaction;
        let interleaved = false;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const options = args[1];
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const find = tx.teamDirectorySource.findUnique.bind(tx.teamDirectorySource);
                // The Prisma adapter is the system boundary; its query still executes against PostgreSQL.
                tx.teamDirectorySource.findUnique = (async (input: Parameters<typeof find>[0]) => {
                    const row = await find(input);
                    if (method === "findUnique" && input.where.id === sourceId && !interleaved) {
                        interleaved = true;
                        await peer();
                    }
                    return row;
                }) as unknown as typeof tx.teamDirectorySource.findUnique;
                const findFirst = tx.teamDirectorySource.findFirst.bind(tx.teamDirectorySource);
                tx.teamDirectorySource.findFirst = (async (input: Parameters<typeof findFirst>[0]) => {
                    const row = await findFirst(input);
                    if (method === "findFirst" && input?.where?.id === sourceId && !interleaved) {
                        interleaved = true;
                        await peer();
                    }
                    return row;
                }) as unknown as typeof tx.teamDirectorySource.findFirst;
                return await callback(tx);
            }, forceReadCommitted && options && typeof options === "object"
                ? { ...options, isolationLevel: "ReadCommitted" } : options]);
        } });
        try {
            const result = await run();
            expect(interleaved).toBe(true);
            return result;
        } finally { db.$transaction = original; }
    }

    it("full claim observes a human retry reset even when its state and run token stay unchanged", async () => {
        const { actor, team, source } = await fixture();
        const now = new Date("2026-10-01T11:00:00Z");
        const requestedAt = new Date(now.getTime() - 1_000);
        await db.teamDirectorySource.update({ where: { id: source.id }, data: {
            state: "initializing", lastErrorCode: "upstream_error", consecutiveFailureCount: 1,
            retryNotBefore: new Date(now.getTime() - 2_000), manualSyncRequestedAt: requestedAt,
        } });
        const result = await afterSourceRead(source.id, async () => {
            expect(await setDirectorySourcePausedForActor({ teamId: team.id, sourceId: source.id,
                actorAccountId: actor.id, authenticationAuthority: "present_user", paused: false, now }))
                .toMatchObject({ ok: true });
        }, () => claimDirectorySourceFullReconcile({ sourceId: source.id, now }), true);
        expect(result).toMatchObject({ ok: true, source: {
            consecutiveFailureCount: 0, observedManualSyncRequestedAt: requestedAt,
        } });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
            state: "initializing", lastErrorCode: null, consecutiveFailureCount: 0, retryNotBefore: null,
        });
    });

    async function managedMember(input: Awaited<ReturnType<typeof fixture>>) {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const identity = await db.teamProvisionedIdentity.create({ data: {
            directorySourceId: input.source.id, teamId: input.team.id, externalUserId: randomUUID(),
            boundAccountId: account.id, state: "active", lastSeenReconcileRunId: "previous-run",
        } });
        expect(await inTx(tx => applyExternalTeamMembershipInTx(tx, {
            teamId: input.team.id, accountId: account.id, desired: "active", historyAccess: "from_membership",
            source: { kind: "directory_source", directorySourceId: input.source.id, externalUserId: identity.externalUserId },
        }))).toMatchObject({ status: "applied" });
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: input.team.id, accountId: account.id } },
        });
        return { account, identity, membership };
    }

    it.each(["pause", "sync"] as const)("observed deletion retains the source and native facts when human %s commits after admission", async operation => {
        const input = await fixture();
        const managed = await managedMember(input);
        const result = await afterSourceRead(input.source.id, async () => {
            const authority = { teamId: input.team.id, sourceId: input.source.id,
                actorAccountId: input.actor.id, authenticationAuthority: "present_user" as const };
            expect(operation === "pause" ? await setDirectorySourcePausedForActor({ ...authority, paused: true })
                : await syncDirectorySourceForActor(authority)).toMatchObject({ ok: true });
        }, () => removeDirectorySourceForObservedDeletion({ teamId: input.team.id, sourceId: input.source.id,
            expectedState: "active", reconcileRunId: null, expectedPosition: { eventCursor: "event_before" } }), true, "findFirst");
        expect(result).toEqual({ applied: false, reason: "stale_run" });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: input.source.id } }))
            .toMatchObject({ state: operation === "pause" ? "paused" : "active" });
        expect(await db.teamMembership.findUniqueOrThrow({ where: { id: managed.membership.id } }))
            .toMatchObject({ accountId: managed.account.id });
        expect(await db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: managed.identity.id } }))
            .toMatchObject({ state: "active", teamMembershipId: managed.membership.id });
    });

    it.each(["pause", "new_request", "coalesced_request"] as const)("activation preserves human %s decisions and rolls back stale native effects", async operation => {
        const input = await fixture();
        const managed = await managedMember(input);
        const observed = operation === "coalesced_request" ? new Date("2026-10-01T09:00:00Z") : null;
        await db.teamDirectorySource.update({ where: { id: input.source.id }, data: {
            manualSyncRequestedAt: observed,
        } });
        expect(await claimDirectorySourceFullReconcile({ sourceId: input.source.id,
            reconcileRunId: "activation-run", now: new Date("2026-10-01T11:00:00Z") })).toMatchObject({ ok: true });
        const result = await afterSourceRead(input.source.id, async () => {
            const authority = { teamId: input.team.id, sourceId: input.source.id,
                actorAccountId: input.actor.id, authenticationAuthority: "present_user" as const };
            expect(operation === "pause" ? await setDirectorySourcePausedForActor({ ...authority, paused: true })
                : await syncDirectorySourceForActor(authority)).toMatchObject({ ok: true });
        }, () => completeDirectoryProjection({ sourceId: input.source.id, reconcileRunId: "activation-run",
            observedManualSyncRequestedAt: observed }), true, "findFirst");
        const source = await db.teamDirectorySource.findUniqueOrThrow({ where: { id: input.source.id } });
        if (operation === "pause") {
            expect(result).toEqual({ applied: false, reason: "stale_run" });
            expect(source.state).toBe("paused");
            expect(await db.teamMembership.findUniqueOrThrow({ where: { id: managed.membership.id } }))
                .toMatchObject({ accountId: managed.account.id });
            expect(await db.teamProvisionedIdentity.findUniqueOrThrow({ where: { id: managed.identity.id } }))
                .toMatchObject({ state: "active", teamMembershipId: managed.membership.id });
        } else {
            expect(result).toEqual({ applied: true });
            expect(source.state).toBe("active");
            expect(source.manualSyncRequestedAt).toEqual(operation === "new_request" ? expect.any(Date) : null);
            expect(await db.teamMembership.findUnique({ where: { id: managed.membership.id } })).toBeNull();
        }
    });

    it.each(["direct", "actor"] as const)("%s request recomputes its marker after a concurrent claim and preserves it through completion", async entry => {
        const { actor, team, source } = await fixture();
        const now = new Date("2026-10-01T11:00:00Z");
        const attemptedAt = new Date(now.getTime() + 1_000);
        const result = await afterSourceRead<
            Awaited<ReturnType<typeof requestDirectorySourceSync>>
            | Awaited<ReturnType<typeof syncDirectorySourceForActor>>
        >(source.id, async () => {
            expect(await claimDirectorySourceFullReconcile({ sourceId: source.id, reconcileRunId: "peer-run", now: attemptedAt }))
                .toMatchObject({ ok: true, source: { observedManualSyncRequestedAt: null } });
        }, () => entry === "direct" ? requestDirectorySourceSync({ sourceId: source.id, now })
            : syncDirectorySourceForActor({ teamId: team.id, sourceId: source.id,
                actorAccountId: actor.id, authenticationAuthority: "present_user", now }), true);
        const requested = await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } });
        expect(requested.manualSyncRequestedAt).toEqual(new Date(attemptedAt.getTime() + 1));
        expect(result).toMatchObject(entry === "direct" ? { ok: true, status: "coalesced" }
            : { ok: true, value: { status: "coalesced" } });
        expect(await completeDirectoryProjection({ sourceId: source.id, reconcileRunId: "peer-run",
            observedManualSyncRequestedAt: null })).toEqual({ applied: true });
        expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: source.id } }))
            .toMatchObject({ state: "active", manualSyncRequestedAt: requested.manualSyncRequestedAt });
    });

    it.each(["full", "incremental", "actor_request"] as const)("%s progresses while the Account cursor changes on every attempt", async mode => {
        const { actor, team, source } = await fixture();
        await db.teamDirectorySource.update({ where: { id: source.id }, data: { lastErrorCode: "upstream_error" } });
        const { result, advances } = await withAccountPublicationBeforeTransactionSql(actor.id,
            sql => sql.includes('FROM "Account"') && sql.endsWith(mode === "actor_request" ? "FOR KEY SHARE" : "FOR NO KEY UPDATE"), async () => {
                if (mode === "full") return await claimDirectorySourceFullReconcile({ sourceId: source.id });
                if (mode === "incremental") return await claimWorkosDirectorySourceIncremental({ sourceId: source.id });
                return await syncDirectorySourceForActor({ teamId: team.id, sourceId: source.id,
                    actorAccountId: actor.id, authenticationAuthority: "present_user" });
            });
        expect(result).toMatchObject({ ok: true });
        expect(advances).toBeGreaterThan(0);
    });

});
