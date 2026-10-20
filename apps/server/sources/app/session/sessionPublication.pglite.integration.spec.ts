import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPostgresMigrations } from "../../../scripts/prismaMigrations";
import { db, initDbPglite, shutdownDbPglite } from "@/storage/db";
import { inTx, transactionResult } from "@/storage/inTx";
import { applyEnvValues, restoreEnv, snapshotEnv } from "@/testkit/env";
import { createPresentUserSessionAccessAuthentication } from "./access/sessionAccessAuthentication.testkit";
import { applySessionTurnMutation } from "./sessionWriteService";
import { markAccountChanged, markAccountsChanged, markSessionAccountsChanged } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "./changeTracking/acquireSessionAccountCursorLocksInTx";

describe("Session and Account publication on PGlite", () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let initialized = false;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "happier-session-publication-pglite-"));
        const databaseDir = join(root, "pglite");
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), "prisma/migrations") });
        } finally {
            await database.close();
        }
        applyEnvValues({
            HAPPIER_DB_PROVIDER: "pglite",
            HAPPY_DB_PROVIDER: "pglite",
            HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir,
            HAPPY_SERVER_LIGHT_DB_DIR: databaseDir,
        });
        await initDbPglite();
        initialized = true;
        await db.$connect();
    }, 120_000);

    afterAll(async () => {
        try {
            if (initialized) await shutdownDbPglite();
        } finally {
            restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });

    it("commits a Turn, receipt and Session cursor, then replays without republishing", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const params = {
            actorUserId: account.id,
            authentication: createPresentUserSessionAccessAuthentication(),
            mutation: { v: 1, sessionId: session.id, mutationId: randomUUID(), turnId: randomUUID(),
                action: "begin", observedAt: 100 },
        } as const;
        expect(await applySessionTurnMutation(params)).toMatchObject({
            ok: true, didApply: true, latestTurnStatus: "in_progress", recipientCursors: [{ accountId: account.id, cursor: 1 }],
        });
        expect(await db.sessionTurn.findUniqueOrThrow({ where: { sessionId_turnId: {
            sessionId: session.id, turnId: params.mutation.turnId,
        } } })).toMatchObject({ status: "in_progress", startedAt: 100n });
        expect(await db.sessionTurnMutationReceipt.findUniqueOrThrow({ where: { sessionId_mutationId: {
            sessionId: session.id, mutationId: params.mutation.mutationId,
        } } })).toMatchObject({ decision: "applied", observedAt: 100n });
        expect(await db.accountChange.findMany({ where: { accountId: account.id },
            select: { kind: true, entityId: true, sessionId: true, cursor: true } }))
            .toEqual([{ kind: "session", entityId: session.id, sessionId: session.id, cursor: 1 }]);
        expect(await applySessionTurnMutation(params)).toMatchObject({ ok: true, didApply: false });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 1 });
    });

    it("publishes batch and hinted point changes with PostgreSQL coalescing semantics", async () => {
        const accounts = await Promise.all([0, 1].map(() => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        })));
        const accountIds = accounts.map(account => account.id).sort();
        const session = await db.session.create({ data: {
            accountId: accountIds[0], tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const cursors = await inTx(async tx => {
            const batch = await markAccountsChanged(tx, { accountIds, entityId: "settings" });
            const sessions = await markSessionAccountsChanged(tx, new Map([[session.id, accountIds]]));
            const point = await markAccountChanged(tx, {
                accountId: accountIds[0], kind: "account", entityId: "hinted", hint: { keys: ["theme"] },
            });
            return transactionResult(() => [...batch, ...sessions, point].map(row => ({
                accountId: row.accountId, cursor: row.resolveCursor(),
            })));
        });
        expect(cursors).toEqual([
            ...accountIds.map(accountId => ({ accountId, cursor: 1 })),
            ...accountIds.map(accountId => ({ accountId, cursor: 2 })),
            { accountId: accountIds[0], cursor: 3 },
        ]);
        expect(await db.accountChange.findMany({ where: { accountId: accountIds[0] }, orderBy: { cursor: "asc" },
            select: { kind: true, entityId: true, cursor: true, hint: true, sessionId: true } }))
            .toEqual([
                { kind: "account", entityId: "settings", cursor: 1, hint: null, sessionId: null },
                { kind: "session", entityId: session.id, cursor: 2, hint: null, sessionId: session.id },
                { kind: "account", entityId: "hinted", cursor: 3, hint: { keys: ["theme"] }, sessionId: null },
            ]);
    });

    it("executes the Session resource fence on the PostgreSQL-compatible engine", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", metadata: "{}",
        } });
        const fencedSessions: unknown[] = [];
        await inTx(async tx => {
            // Observe the real SQL-driver boundary: PGlite has one connection,
            // so a competing connection cannot independently probe row locks.
            const observed = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(target, property, receiver);
                    return async (query: string, ...values: unknown[]) => {
                        const rows = await target.$queryRawUnsafe(query, ...values);
                        if (query.includes('FROM "Session"') && query.includes("FOR NO KEY UPDATE")) fencedSessions.push(rows);
                        return rows;
                    };
                },
            });
            expect(await acquireSessionAccountCursorLocksInTx(observed, [session.id])).toEqual([account.id]);
        });
        expect(fencedSessions).toEqual([[{ id: session.id }]]);
    });
});
