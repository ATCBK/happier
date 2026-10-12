import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { markAccountChanged, markAccountsChanged } from "./markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported AccountChange DB contract provider: ${raw}`);
}

const provider = resolveContractProvider();
const publicKeyPrefix = "dbcontract-account-change-coalescing-";

describe("AccountChange coalescing database contract", () => {
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

    afterEach(async () => {
        await db.session.deleteMany({ where: { account: { publicKey: { startsWith: publicKeyPrefix } } } });
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) await db.$disconnect();
    });

    it.skipIf(provider !== "postgres")("keeps higher cursors invisible until the earlier Account change commits", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        let allocated!: () => void;
        const firstAllocated = new Promise<void>(resolve => { allocated = resolve; });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const first = inTx(async tx => {
            const cursor = await markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: "first" });
            allocated();
            await mayCommit;
            return cursor;
        }, { isolationLevel: "ReadCommitted" });
        const firstOutcome = Promise.allSettled([first]);
        await firstAllocated;
        let secondPid = -1;
        let secondSettled = false;
        const second = inTx(async tx => {
            const rows = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
            secondPid = rows[0].pid;
            return markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: "second" });
        }, { isolationLevel: "ReadCommitted" });
        const secondOutcome = Promise.allSettled([second]).finally(() => { secondSettled = true; });
        try {
            // Observe the PostgreSQL wait instead of relying on timing.
            while (!secondSettled) {
                const rows = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting", secondPid,
                );
                if (rows[0].waiting) break;
            }
            expect(secondSettled).toBe(false);
            expect(await db.accountChange.findMany({ where: { accountId: account.id } })).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
        } finally { release(); }
        const outcomes = [...await firstOutcome, ...await secondOutcome];
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        const page = (after: number) => db.accountChange.findMany({ where: { accountId: account.id, cursor: { gt: after } },
            orderBy: { cursor: "asc" }, take: 1, select: { cursor: true, entityId: true } });
        expect(await page(0)).toEqual([{ cursor: 1, entityId: "first" }]);
        expect(await page(1)).toEqual([{ cursor: 2, entityId: "second" }]);
        expect(await page(2)).toEqual([]);
    });

    it.skipIf(provider !== "postgres").each([false, true])("waits for the first ordered Account before locking a later physical row (hinted=%s)", async hinted => {
        const stem = `batch-lock-${randomUUID()}`;
        // Put b before a in the heap so an unordered UPDATE's scan disagrees
        // with the Session cursor owner's sorted Account acquisition order.
        const second = await db.account.create({ data: { id: `${stem}-b`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const first = await db.account.create({ data: { id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        let releaseHolder!: () => void;
        const holderMayContinue = new Promise<void>(resolve => { releaseHolder = resolve; });
        let holderReady!: () => void;
        const holderHasAccount = new Promise<void>(resolve => { holderReady = resolve; });
        const holder = inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [], [first.id]);
            holderReady();
            await holderMayContinue;
        }, { isolationLevel: "ReadCommitted" });
        const holderResult = Promise.allSettled([holder]);
        await holderHasAccount;
        let batchPid = -1;
        let batchFinished = false;
        const batch = inTx(async tx => {
            const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
            batchPid = row.pid;
            // Exercise a valid physical scan plan, rather than relying on the
            // planner choosing an index scan that accidentally sorts the writes.
            await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
            await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
            return markAccountsChanged(tx, { accountIds: [second.id, first.id], entityId: stem,
                ...(hinted ? { hintForAccount: (accountId: string) => ({ recipient: accountId }) } : {}),
            });
        }, { isolationLevel: "ReadCommitted" });
        const batchResult = Promise.allSettled([batch]).finally(() => { batchFinished = true; });
        try {
            while (!batchFinished) {
                const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting", batchPid,
                );
                if (row.waiting) break;
            }
            await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', second.id,
            ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: second.id }]);
        } finally {
            releaseHolder();
            vi.unstubAllEnvs();
            for (const outcome of [...await holderResult, ...await batchResult]) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
        }
        expect(await db.accountChange.findMany({ where: { entityId: stem }, orderBy: { accountId: "asc" },
            select: { accountId: true, hint: true } })).toEqual([first, second].map(account => ({
            accountId: account.id, hint: hinted ? { recipient: account.id } : null,
        })));
    });

    it.skipIf(provider !== "postgres")("keeps Account lock order when a lower-id reader is granted after audience discovery", async () => {
        const { putSessionAccessGrantInTx } = await import("@/app/session/access/sessionAccessGrantService");
        const { markSessionProjectionRecipientsChanged } = await import("@/app/session/changeTracking/markSessionProjectionRecipientsChanged");
        type Tx = Parameters<Parameters<typeof inTx>[0]>[0];
        const stem = `audience-expansion-${randomUUID()}`;
        const owner = await db.account.create({ data: {
            id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        const reader = await db.account.create({ data: {
            id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        await db.userRelationship.createMany({ data: [
            { fromUserId: owner.id, toUserId: reader.id, status: "friend" },
            { fromUserId: reader.id, toUserId: owner.id, status: "friend" },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: stem, encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
        } });
        const rawDriverFailures: unknown[] = [];
        let discovered!: () => void;
        const oldAudienceDiscovered = new Promise<void>(resolve => { discovered = resolve; });
        let allowInitialLock!: () => void;
        const grantMayCommitFirst = new Promise<void>(resolve => { allowInitialLock = resolve; });
        let locked!: () => void;
        const ownerLocked = new Promise<void>(resolve => { locked = resolve; });
        let allowFanout!: () => void;
        const peerMayWaitFirst = new Promise<void>(resolve => { allowFanout = resolve; });
        let interceptInitialLock = true;
        let firstPid = -1;
        let peerPid = -1;
        let peerFinished = false;

        // The real DB transport alone is intercepted: every grant, audience
        // resolver, Account lock and cursor publication executes unchanged.
        const observeTransport = (tx: Tx, interleave: boolean): Tx => new Proxy(tx, {
            get(target, key) {
                if (key === "$queryRawUnsafe") return async <T>(query: string, ...values: unknown[]): Promise<T> => {
                    const pause = interleave && interceptInitialLock
                        && query.includes('FROM "Account"') && query.includes("FOR NO KEY UPDATE");
                    if (pause) {
                        interceptInitialLock = false;
                        expect(values[0]).toEqual([owner.id]);
                        discovered();
                        await grantMayCommitFirst;
                    }
                    try {
                        const result = await target.$queryRawUnsafe<T>(query, ...values);
                        if (pause) {
                            locked();
                            await peerMayWaitFirst;
                        }
                        return result;
                    } catch (error) {
                        rawDriverFailures.push(error);
                        throw error;
                    }
                };
                const member: unknown = Reflect.get(target, key, target);
                return typeof member === "function" ? member.bind(target) : member;
            },
        });
        const first = inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
            firstPid = backend.pid;
            const observed = observeTransport(tx, true);
            await acquireSessionAccountCursorLocksInTx(observed, [session.id]);
            return markSessionProjectionRecipientsChanged({ tx: observed, sessionId: session.id });
        });
        const firstOutcome = Promise.allSettled([first]);
        let peerOutcome: Promise<PromiseSettledResult<Awaited<typeof first>>[]> | undefined;
        let setupFailure: unknown;
        try {
            await Promise.race([oldAudienceDiscovered, firstOutcome.then(() => {
                throw new Error("Publication ended before initial audience discovery");
            })]);
            await expect(inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: reader.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
            }), { isolationLevel: "Serializable" })).resolves.toMatchObject({ ok: true, changed: true });
            allowInitialLock();
            await Promise.race([ownerLocked, firstOutcome.then(() => {
                throw new Error("Publication ended before acquiring the owner Account");
            })]);
            const peer = inTx(async tx => {
                const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                peerPid = backend.pid;
                const observed = observeTransport(tx, false);
                await acquireSessionAccountCursorLocksInTx(observed, [session.id]);
                return markSessionProjectionRecipientsChanged({ tx: observed, sessionId: session.id });
            });
            peerOutcome = Promise.allSettled([peer]).finally(() => { peerFinished = true; });
            while (!peerFinished) {
                const [blocking] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS waiting", firstPid, peerPid,
                );
                if (blocking.waiting) break;
            }
            expect(peerFinished).toBe(false);
        } catch (error) {
            setupFailure = error;
        } finally {
            allowInitialLock();
            allowFanout();
        }
        const outcomes = [...await firstOutcome, ...(peerOutcome ? await peerOutcome : [])];
        if (setupFailure !== undefined) throw setupFailure;
        // A swallowed/retried 40P01 still falsifies the Account-order contract.
        expect(rawDriverFailures).toEqual([]);
        expect(outcomes).toHaveLength(2);
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason;
            expect(outcome.value.map(cursor => cursor.accountId)).toEqual([reader.id, owner.id]);
        }
    });

    it(`batches hint-free Session changes with the same hints and Session identity as the point writer on ${provider}`, async () => {
        const accounts = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, updatedAt: new Date(1_000) }, select: { id: true },
        })));
        const session = await db.session.create({ data: {
            accountId: accounts[0].id, tag: randomUUID(), metadata: "{}",
        }, select: { id: true } });
        await inTx(async tx => {
            for (const account of accounts) await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: session.id, hint: { sharedMetadataVersion: 7 },
            });
        });
        const cursors = await inTx(tx => markAccountsChanged(tx, {
            accountIds: accounts.map(account => account.id), entityId: session.id, kind: "session",
        }));
        expect(cursors.map(cursor => cursor.accountId)).toEqual(accounts.map(account => account.id).sort());
        const changes = await db.accountChange.findMany({ where: { entityId: session.id, kind: "session" },
            orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true, sessionId: true, hint: true } });
        expect(changes).toEqual(cursors.map(cursor => ({ ...cursor, sessionId: session.id,
            hint: provider === "postgres" ? null : { sharedMetadataVersion: 7 },
        })));
        const accountTimestamps = await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            select: { updatedAt: true } });
        if (provider === "postgres") expect(accountTimestamps.every(row => row.updatedAt.getTime() === 1_000)).toBe(true);
        else expect(accountTimestamps.every(row => row.updatedAt.getTime() > 1_000)).toBe(true);
        await db.session.delete({ where: { id: session.id } });
        expect(await db.accountChange.findMany({ where: { entityId: session.id }, orderBy: { accountId: "asc" },
            select: { accountId: true, cursor: true, sessionId: true, hint: true } })).toEqual(cursors.map(cursor => ({
            ...cursor, sessionId: null, hint: provider === "postgres" ? null : { sharedMetadataVersion: 7 },
        })));
    });

    it(`replaces hint-free Account projections and rolls back incomplete audiences on ${provider}`, async () => {
        const accounts = await Promise.all(Array.from({ length: 2 }, () => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, updatedAt: new Date(1_000) }, select: { id: true },
        })));
        const entityId = `projection-${randomUUID()}`;
        await inTx(async tx => {
            for (const account of accounts) await markAccountChanged(tx, {
                accountId: account.id, entityId, kind: "account", hint: { full: true },
            });
        });
        const cursors = await inTx(tx => markAccountsChanged(tx, { accountIds: accounts.map(account => account.id), entityId }));
        expect(await db.accountChange.findMany({ where: { entityId }, orderBy: { accountId: "asc" },
            select: { accountId: true, cursor: true, hint: true, sessionId: true } }))
            .toEqual(cursors.map(cursor => ({ ...cursor, hint: null, sessionId: null })));
        expect((await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            select: { updatedAt: true } })).every(row => row.updatedAt.getTime() > 1_000)).toBe(true);
        await expect(inTx(tx => markAccountsChanged(tx, {
            accountIds: [accounts[0].id, "missing-recipient"], entityId,
        }))).rejects.toThrow("every Account recipient must exist");
        expect(await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            orderBy: { id: "asc" }, select: { id: true, seq: true } }))
            .toEqual(cursors.map(cursor => ({ id: cursor.accountId, seq: cursor.cursor })));
    });

    it(`keeps a retained Collection full hint broad across a later exact hint on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const collectionId = "tasks";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const fullCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "a".repeat(43),
                    revision: 4,
                    full: true,
                },
            })
        ));
        const exactCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    rowIds: ["task-1"],
                },
            })
        ));

        expect(exactCursor).toBeGreaterThan(fullCursor);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "pluginDomain",
                    entityId,
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: exactCursor,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId,
                contractDigest: "b".repeat(43),
                revision: 5,
                full: true,
            },
        });
    });

    it(`preserves exact-only and separate Collection identities on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const exactCollectionId = "exact-only";
        const fullCollectionId = "separate-full";
        const exactEntityId = `pluginDomain/${pluginId}/data-collection/${exactCollectionId}`;
        const fullEntityId = `pluginDomain/${pluginId}/data-collection/${fullCollectionId}`;

        await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 1,
                    rowIds: ["first"],
                },
            })
        ));
        const fullCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: fullEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: fullCollectionId,
                    contractDigest: "d".repeat(43),
                    revision: 3,
                    full: true,
                },
            })
        ));
        const exactCursor = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 2,
                    rowIds: ["second"],
                },
            })
        ));

        await expect(db.accountChange.findMany({
            where: { accountId: account.id, kind: "pluginDomain" },
            orderBy: { entityId: "asc" },
            select: { cursor: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: exactCursor,
            entityId: exactEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: exactCollectionId,
                contractDigest: "c".repeat(43),
                revision: 2,
                rowIds: ["second"],
            },
        }, {
            cursor: fullCursor,
            entityId: fullEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: fullCollectionId,
                contractDigest: "d".repeat(43),
                revision: 3,
                full: true,
            },
        }]);
    });
});
