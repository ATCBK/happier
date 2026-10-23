import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAccountPublicationBeforeTransactionSql } from "@/app/changes/accountPublicationContention.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { createDirectorySourceForActor, setDirectorySourcePausedForActor } from "./directorySourceAdministration";
import { completeActiveWorkosEmptyPoll } from "./directoryProjectionRepository";
import { markActiveWorkosDirectoryPollFailed, markDirectorySourceReconcileFailed } from "./directorySourceService";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Directory source Account publication", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["create", "pause", "poll_failure", "reconcile_failure", "empty_poll"] as const)(
        "%s commits after another writer advances its Account cursor", async operation => {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: `Directory publication ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", enabled: true, displayName: "Directory company",
            config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_directory", connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        const source = operation === "create" ? null : await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "workos_directory", displayName: "Directory",
            externalSourceKey: randomUUID(), teamIdentityConnectionId: connection.id,
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: "directory_exact" },
            state: operation === "reconcile_failure" ? "initializing" : "active",
            activeReconcileRunId: operation === "reconcile_failure" || operation === "poll_failure" ? "current-run" : null,
            activeReconcileStartedAt: operation === "reconcile_failure" || operation === "poll_failure" ? new Date() : null,
            eventCursor: "event_before", lastErrorCode: operation === "empty_poll" ? "upstream_error" : null,
        } });
        const input = { teamId: team.id, actorAccountId: actor.id, authenticationAuthority: "present_user" as const };
        const directoryEnv = { WORKOS_API_KEY: "sk_test_directory", WORKOS_CLIENT_ID: "client_directory" };
        const sourceId = source?.id ?? "uncreated";
        const { result, advances } = await withAccountPublicationBeforeTransactionSql(actor.id,
            sql => sql.includes('FROM "Account"') && sql.endsWith("FOR NO KEY UPDATE"), async () => {
                if (operation === "create") return await createDirectorySourceForActor({ ...input, v: 1,
                    kind: "workos_directory", teamIdentityConnectionId: connection.id,
                    workosDirectoryId: "directory_exact", displayName: "Created directory" });
                if (operation === "pause") return await setDirectorySourcePausedForActor({ ...input, sourceId, paused: true });
                if (operation === "poll_failure") return await markActiveWorkosDirectoryPollFailed({ sourceId,
                    expectedPosition: { eventCursor: "event_before" }, reconcileRunId: "current-run", errorCode: "upstream_error" });
                if (operation === "reconcile_failure") return await markDirectorySourceReconcileFailed({ sourceId,
                    reconcileRunId: "current-run", errorCode: "upstream_error" });
                return await completeActiveWorkosEmptyPoll({ sourceId, expectedPosition: { eventCursor: "event_before" },
                    env: directoryEnv });
            });
        expect(result).toMatchObject(operation === "create" || operation === "pause" ? { ok: true } : { applied: true });
        expect(advances).toBeGreaterThan(0);
        const persisted = await db.teamDirectorySource.findFirstOrThrow({ where: { teamId: team.id } });
        if (operation === "create") {
            expect(persisted).toMatchObject({ state: "initializing", displayName: "Created directory" });
            expect(await db.teamDirectorySource.count({ where: { teamId: team.id } })).toBe(1);
        } else if (operation === "pause") {
            expect(persisted).toMatchObject({ state: "paused", activeReconcileRunId: null, manualSyncRequestedAt: null });
            await expect(setDirectorySourcePausedForActor({ ...input, sourceId, paused: false }))
                .resolves.toMatchObject({ ok: true });
            const resumed = await db.teamDirectorySource.findUniqueOrThrow({ where: { id: sourceId } });
            expect(resumed).toMatchObject({ state: "initializing", activeReconcileRunId: null });
            expect(resumed.manualSyncRequestedAt).not.toBeNull();
        } else if (operation === "empty_poll") {
            expect(persisted.lastSuccessAt).not.toBeNull();
            expect(persisted.lastErrorCode).toBeNull();
            await expect(completeActiveWorkosEmptyPoll({ sourceId, expectedPosition: { eventCursor: "stale" }, env: directoryEnv }))
                .resolves.toEqual({ applied: false, reason: "stale_run" });
        } else {
            expect(persisted).toMatchObject({ state: "needs_attention", activeReconcileRunId: null, lastErrorCode: "upstream_error" });
            const stale = operation === "poll_failure"
                ? await markActiveWorkosDirectoryPollFailed({ sourceId, expectedPosition: { eventCursor: "event_before" },
                    reconcileRunId: "current-run", errorCode: "stale_failure" })
                : await markDirectorySourceReconcileFailed({ sourceId, reconcileRunId: "current-run", errorCode: "stale_failure" });
            expect(stale).toEqual({ applied: false, reason: "stale_run" });
            expect(await db.teamDirectorySource.findUniqueOrThrow({ where: { id: sourceId } }))
                .toMatchObject({ lastErrorCode: "upstream_error" });
        }
    });
});
