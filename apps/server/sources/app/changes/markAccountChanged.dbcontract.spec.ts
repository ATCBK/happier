import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { inTx, transactionResult } from "@/storage/inTx";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { markAccountChanged, markAccountsChanged, markSessionAccountsChanged } from "./markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { recordConnectedServiceAccountProfileChange } from '@/app/api/routes/connect/connectedServicesAccountProfileChange';

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
        eventRouter.clearIo();
        await db.session.deleteMany({ where: { account: { publicKey: { startsWith: publicKeyPrefix } } } });
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) await db.$disconnect();
    });

    it(`keeps connected service entities cursor-relative and independent of self changes on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const first = { pluginId: 'test.connected', localId: 'first' };
        const second = { pluginId: 'test.connected', localId: 'second' };
        const firstChange = buildConnectedServicesAccountChangeV1(first);
        const secondChange = buildConnectedServicesAccountChangeV1(second);
        const broadChange = buildConnectedServicesAccountChangeV1();
        const readChanges = (after = 0) => db.accountChange.findMany({
            where: { accountId: account.id, cursor: { gt: after } }, orderBy: { cursor: 'asc' },
            select: { kind: true, entityId: true, hint: true },
        });
        await inTx(async tx => {
            // Retained predecessor self flags are replaced by ordinary self facts.
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { connectedServices: true } });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: second });
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { settingsVersion: 7 } });
        });
        expect(await readChanges()).toEqual([
            firstChange, secondChange, { kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } },
        ]);
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
            hint: { username: true } }));
        expect((await readChanges()).at(-1)).toEqual({ kind: 'account', entityId: 'self', hint: { username: true } });
        await inTx(tx => markAccountsChanged(tx, { accountIds: [account.id], kind: 'account', entityId: 'self' }));
        expect((await readChanges()).at(-1)?.hint).toBeNull();
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id }));
        expect(await readChanges()).toHaveLength(4);
        expect((await readChanges()).at(-1)).toEqual(broadChange);
        const checkpoint = (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq;
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first }));
        expect(await readChanges(checkpoint)).toEqual([firstChange]);
    });

    it(`retains queued Session and Machine removal changes after domain work deletes their rows on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const pointSession = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const batchSession = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const pointMachine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const batchMachine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });

        const changes = await inTx(async tx => {
            const pointSessionChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: pointSession.id, hint: { removed: true },
            });
            const [batchSessionChange] = await markSessionAccountsChanged(tx, new Map([[batchSession.id, [account.id]]]));
            const pointMachineChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "machine", entityId: pointMachine.id, hint: { removed: true },
            });
            const [batchMachineChange] = await markAccountsChanged(tx, {
                accountIds: [account.id], kind: "machine", entityId: batchMachine.id, hint: { removed: true, batch: true },
            });
            await tx.session.deleteMany({ where: { id: { in: [pointSession.id, batchSession.id] } } });
            await tx.machine.deleteMany({ where: { id: { in: [pointMachine.id, batchMachine.id] } } });
            expect(emit).not.toHaveBeenCalled();
            return transactionResult(() => [
                { kind: "session", entityId: pointSession.id, cursor: pointSessionChange.resolveCursor(), hint: { removed: true } },
                { kind: "session", entityId: batchSession.id, cursor: batchSessionChange.resolveCursor(), hint: null },
                { kind: "machine", entityId: pointMachine.id, cursor: pointMachineChange.resolveCursor(), hint: { removed: true } },
                { kind: "machine", entityId: batchMachine.id, cursor: batchMachineChange.resolveCursor(), hint: { removed: true, batch: true } },
            ]);
        });

        expect(changes.map(change => change.cursor).sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
        await expect(db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: "asc" },
            select: { kind: true, entityId: true, cursor: true, hint: true,
                sessionId: true, machineId: true, artifactId: true, accountPetPackageId: true } }))
            .resolves.toEqual(changes.map(change => ({ ...change,
                sessionId: null, machineId: null, artifactId: null, accountPetPackageId: null,
            })).sort((left, right) => left.cursor - right.cursor));
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({ seq: 4, body: { t: "account-change" } }));
    });

    it.skipIf(provider !== "postgres")("allocates cursors in terminal commit order and never exposes a late cursor below the checkpoint", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        let recorded!: () => void;
        const firstRecorded = new Promise<void>(resolve => { recorded = resolve; });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const first = inTx(async tx => {
            const publication = await markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: "first" });
            expect(() => publication.resolveCursor()).toThrow();
            recorded();
            await mayCommit;
            return publication;
        }, { isolationLevel: "ReadCommitted" });
        const firstOutcome = Promise.allSettled([first]);
        await Promise.race([firstRecorded, firstOutcome.then(() => { throw new Error("First writer ended before recording publication"); })]);
        let checkpoint = 0;
        let setupFailure: unknown;
        try {
            expect(await db.accountChange.findMany({ where: { accountId: account.id } })).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
            const second = await inTx(tx => markAccountChanged(tx, {
                accountId: account.id, kind: "account", entityId: "second",
            }), { isolationLevel: "ReadCommitted" });
            checkpoint = second.resolveCursor();
            expect(checkpoint).toBe(1);
            expect(await db.accountChange.findMany({ where: { accountId: account.id },
                select: { cursor: true, entityId: true } })).toEqual([{ cursor: checkpoint, entityId: "second" }]);
        } catch (error) {
            setupFailure = error;
        } finally { release(); }
        const outcomes = await firstOutcome;
        if (setupFailure !== undefined) throw setupFailure;
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        const page = (after: number) => db.accountChange.findMany({ where: { accountId: account.id, cursor: { gt: after } },
            orderBy: { cursor: "asc" }, take: 1, select: { cursor: true, entityId: true } });
        expect(await page(0)).toEqual([{ cursor: 1, entityId: "second" }]);
        expect(await page(checkpoint)).toEqual([{ cursor: 2, entityId: "first" }]);
        expect(await page(2)).toEqual([]);
    });

    it.skipIf(provider !== "postgres").each(["batch", "hinted", "separate"] as const)("locks the complete terminal audience in order before a later physical row (%s)", async mode => {
        const hinted = mode === "hinted";
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
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE', first.id);
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
            if (mode === "separate") {
                // Separate point calls must join the same complete sorted
                // terminal audience, even when recorded in reverse order.
                await markAccountChanged(tx, { accountId: second.id, kind: "account", entityId: stem });
                await markAccountChanged(tx, { accountId: first.id, kind: "account", entityId: stem });
                return;
            }
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

    it.skipIf(provider !== "postgres")("admits the complete Follow destination audience compatibly while excluding authority changes", async () => {
        const stem = `follow-publication-${randomUUID()}`;
        const destinationOwner = await db.account.create({ data: { id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const sourceOwner = await db.account.create({ data: { id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: `${stem}-source`, metadata: '{}' } });
        const destination = await db.session.create({ data: { accountId: destinationOwner.id, tag: `${stem}-destination`, metadata: '{}' } });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id, policyJson: '{"preset":"quiet"}' } });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const locked = new Promise<void>(resolve => { ready = resolve; });
        const first = inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [source.id]);
            ready();
            await mayCommit;
        }, { isolationLevel: 'ReadCommitted' });
        const firstOutcome = Promise.allSettled([first]);
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            await Promise.race([locked, firstOutcome.then(() => { throw new Error('Publication ended before lock acquisition'); })]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', destinationOwner.id,
            ), { isolationLevel: 'ReadCommitted' })).resolves.toEqual([{ id: destinationOwner.id }]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', destinationOwner.id,
            ), { isolationLevel: 'ReadCommitted' })).rejects.toThrow();
        } finally {
            release();
            vi.unstubAllEnvs();
            for (const outcome of await firstOutcome) if (outcome.status === 'rejected') throw outcome.reason;
        }
    });

    it.skipIf(provider !== "postgres").each(["unpublished", "inactive"] as const)("fences a granted %s reader before publication can expand the audience", async state => {
        const stem = `audience-prospective-${randomUUID()}`;
        const owner = await db.account.create({ data: {
            id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        const reader = await db.account.create({ data: {
            id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
            status: state === "inactive" ? "suspended" : "active",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: stem, encryptionMode: "plain", metadata: "{}",
            currentStorageState: state === "unpublished" ? "external" : "hosted",
        } });
        await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: "view",
        } });
        let locked!: () => void;
        const locksAcquired = new Promise<void>(resolve => { locked = resolve; });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        // This probe deliberately observes NOWAIT refusal while the holder is
        // live; do not spend the production retry/backoff before releasing it.
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        const holder = inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
            locked();
            await mayCommit;
        }, { isolationLevel: "ReadCommitted" });
        const holderOutcome = Promise.allSettled([holder]);
        try {
            await Promise.race([locksAcquired, holderOutcome.then(() => {
                throw new Error("Publication ended before Account acquisition");
            })]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', reader.id,
            ), { isolationLevel: "ReadCommitted" })).rejects.toMatchObject({ code: "database_transaction_conflict_exhausted",
                cause: { code: "P2010", meta: { code: "55P03" } } });
        } finally {
            release();
            vi.unstubAllEnvs();
            for (const outcome of await holderOutcome) if (outcome.status === "rejected") throw outcome.reason;
        }
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
        let interceptInitialLock = true;
        let attempts = 0;

        // The real DB transport alone is intercepted: every grant, audience
        // resolver, Account lock and cursor publication executes unchanged.
        const observeTransport = (tx: Tx, interleave: boolean): Tx => new Proxy(tx, {
            get(target, key) {
                if (key === "$queryRawUnsafe") return async <T>(query: string, ...values: unknown[]): Promise<T> => {
                    const pause = interleave && interceptInitialLock
                        && query.includes('FROM "Account"') && query.includes("FOR KEY SHARE");
                    if (pause) {
                        interceptInitialLock = false;
                        expect(Array.isArray(values[0]) ? values[0] : [values[0]]).toEqual([owner.id]);
                        discovered();
                        await grantMayCommitFirst;
                    }
                    try {
                        const result = await target.$queryRawUnsafe<T>(query, ...values);
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
            attempts += 1;
            const observed = observeTransport(tx, true);
            await acquireSessionAccountCursorLocksInTx(observed, [session.id]);
            await observed.session.update({ where: { id: session.id }, data: { metadataVersion: { increment: 1 } } });
            return markSessionProjectionRecipientsChanged({ tx: observed, sessionId: session.id });
        }, { isolationLevel: "ReadCommitted" });
        const firstOutcome = Promise.allSettled([first]);
        let setupFailure: unknown;
        try {
            await Promise.race([oldAudienceDiscovered, firstOutcome.then(([outcome]) => {
                if (outcome.status === "rejected") throw outcome.reason;
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
        } catch (error) {
            setupFailure = error;
        } finally {
            allowInitialLock();
        }
        const outcomes = await firstOutcome;
        if (setupFailure !== undefined) throw setupFailure;
        // A swallowed/retried 40P01 still falsifies the Account-order contract.
        expect(rawDriverFailures).toEqual([]);
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadataVersion: true } }))
            .toEqual({ metadataVersion: session.metadataVersion + 1 });
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
        const publications = await inTx(tx => markAccountsChanged(tx, {
            accountIds: accounts.map(account => account.id), entityId: session.id, kind: "session",
        }));
        const cursors = publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() }));
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
        const publications = await inTx(tx => markAccountsChanged(tx, { accountIds: accounts.map(account => account.id), entityId }));
        const cursors = publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() }));
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
        const fullPublication = await inTx(async (tx) => (
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
        const exactPublication = await inTx(async (tx) => (
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

        const fullCursor = fullPublication.resolveCursor();
        const exactCursor = exactPublication.resolveCursor();
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

    it(`coalesces queued Collection hints without narrowing a full reread on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` }, select: { id: true },
        });
        const pluginId = "example.contract";
        const collectionId = "queued";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const [full, exact] = await inTx(async tx => {
            const full = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "a".repeat(43), revision: 4, full: true },
            });
            const exact = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "b".repeat(43), revision: 5, rowIds: ["task-1"] },
            });
            return [full, exact] as const;
        });

        expect(exact.resolveCursor()).toBeGreaterThanOrEqual(full.resolveCursor());
        await expect(db.accountChange.findMany({ where: { accountId: account.id },
            select: { entityId: true, cursor: true, hint: true } })).resolves.toEqual([{
            entityId, cursor: exact.resolveCursor(),
            hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                contractDigest: "b".repeat(43), revision: 5, full: true },
        }]);
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
        const fullPublication = await inTx(async (tx) => (
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
        const exactPublication = await inTx(async (tx) => (
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

        const fullCursor = fullPublication.resolveCursor();
        const exactCursor = exactPublication.resolveCursor();
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
