import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';

import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { db, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { runAccountChangeRetentionRule } from './accountChangeRetentionRule';

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('AccountChange retention PostgreSQL publication contract', () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
    });

    it('excludes content writers and publishes the pruned full hint recovery floor atomically without transaction retries', async () => {
        expect(readDatabaseTransactionConfigFromEnv(process.env, 'postgres').maxRetries).toBe(0);
        const account = await db.account.create({ data: { encryptionMode: 'plain', seq: 1 } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const entityId = 'pluginDomain/example.tasks/data-collection/tasks';
        const hint = {
            pluginDomain: 'dataCollection' as const, pluginId: 'example.tasks', collectionId: 'tasks',
            contractDigest: 'a'.repeat(43), revision: 1,
        };
        await db.accountChange.create({ data: {
            accountId: account.id, kind: 'pluginDomain', entityId, cursor: 1,
            changedAt: new Date('2024-01-01T00:00:00.000Z'), hint: { ...hint, full: true },
        } });
        const app = createAuthenticatedTestApp();
        changesRoutes(app);
        const owner = new AsyncLocalStorage<'retention' | 'writer'>();
        const deletionReached = latch();
        const releaseDeletion = latch();
        const writerEntered = latch();
        const originalTransaction = db.$transaction;
        let retentionPid = 0;
        let writerPid = 0;
        let writerInDomain = false;
        let writerSettled = false;
        let paused = false;

        // Interpose only at Prisma's real persistence boundary. The retention
        // decision, DELETE, Account lock/floor, writer and HTTP reader stay real.
        db.$transaction = new Proxy(originalTransaction, {
            apply(target, receiver, args: unknown[]) {
                const operation = args[0];
                if (typeof operation !== 'function') return Reflect.apply(target, receiver, args);
                const currentOwner = owner.getStore();
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                    if (currentOwner === 'retention') retentionPid = pid;
                    if (currentOwner === 'writer') { writerPid = pid; writerEntered.release(); }
                    const accountChange = new Proxy(tx.accountChange, {
                        get(delegate, property, delegateReceiver) {
                            if (property !== 'deleteMany') return Reflect.get(delegate, property, delegateReceiver);
                            return async (query: Parameters<Tx['accountChange']['deleteMany']>[0]) => {
                                const result = await delegate.deleteMany(query);
                                if (currentOwner === 'retention' && result.count === 1 && !paused) {
                                    paused = true;
                                    deletionReached.release();
                                    await releaseDeletion.promise;
                                }
                                return result;
                            };
                        },
                    });
                    return operation(new Proxy(tx, {
                        get(transaction, property, transactionReceiver) {
                            return property === 'accountChange' ? accountChange : Reflect.get(transaction, property, transactionReceiver);
                        },
                    }));
                }, ...args.slice(1)]);
            },
        });

        const retention = owner.run('retention', () => runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'), batchSize: 1,
            dryRun: false, maxDeletesPerRulePerRun: 1,
        }));
        const retentionOutcome = Promise.allSettled([retention]);
        let writerOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
        const readPage = (after: number) => app.inject({
            method: 'GET', url: `/v2/changes?after=${after}&limit=1`,
            headers: { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '3' },
        });
        try {
            await deletionReached.promise;
            const writer = owner.run('writer', () => inTx(async tx => {
                await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
                await tx.session.update({ where: { id: session.id }, data: { metadata: '{"written":true}' } });
                writerInDomain = true;
                await markAccountChanged(tx, {
                    accountId: account.id, kind: 'pluginDomain', entityId,
                    hint: { ...hint, contractDigest: 'b'.repeat(43), revision: 2, rowIds: ['task-1'] },
                });
            })).finally(() => { writerSettled = true; });
            writerOutcome = Promise.allSettled([writer]);
            await writerEntered.promise;
            let blocker: { query: string; blockers: number[] } | undefined;
            while (!writerInDomain && !writerSettled) {
                const [sample] = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
                    'SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1::int', writerPid,
                );
                if (sample?.blockers.includes(retentionPid)) { blocker = sample; break; }
            }
            expect(writerInDomain).toBe(false);
            expect(blocker?.blockers).toContain(retentionPid);
            expect(blocker?.query).toContain('FOR KEY SHARE');

            const duringPrune = await readPage(0);
            expect(duringPrune.statusCode).toBe(200);
            expect(ChangesResponseSchema.parse(duringPrune.json()).changes).toEqual([
                expect.objectContaining({ cursor: 1, entityId, hint: expect.objectContaining({ full: true }) }),
            ]);

            releaseDeletion.release();
            await expect(retention).resolves.toEqual({ deleted: 1, candidatesExamined: 1, hasMore: true });
            for (const result of await writerOutcome) if (result.status === 'rejected') throw result.reason;
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ seq: 2, changesFloor: 1 });
            expect(await db.accountChange.findMany({ where: { accountId: account.id }, select: { cursor: true } })).toEqual([{ cursor: 2 }]);

            const stale = await readPage(0);
            expect(stale.statusCode).toBe(410);
            expect(stale.json()).toEqual({ error: 'cursor-gone', currentCursor: 2 });
            const recovered = await readPage(1);
            expect(recovered.statusCode).toBe(200);
            expect(ChangesResponseSchema.parse(recovered.json())).toMatchObject({
                changes: [expect.objectContaining({ cursor: 2, entityId, hint: expect.objectContaining({ rowIds: ['task-1'] }) })],
                nextCursor: 2,
            });
            const exhausted = await readPage(2);
            expect(exhausted.statusCode).toBe(200);
            expect(ChangesResponseSchema.parse(exhausted.json())).toMatchObject({ changes: [], nextCursor: 2 });
        } finally {
            releaseDeletion.release();
            await retentionOutcome;
            await writerOutcome;
            db.$transaction = originalTransaction;
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    }, 30_000);
});
