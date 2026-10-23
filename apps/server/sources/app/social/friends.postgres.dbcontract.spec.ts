import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@/context';
import { db, initDbPostgres, getDbProviderFromEnv } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { acrossAccountCursorCommit, databaseLatch } from '@/testkit/postgresAccountCursorContention';
import { friendAdd } from './friendAdd';
import { friendRemove } from './friendRemove';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Friends bilateral PostgreSQL admission', () => {
    const accountIds: string[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        initDbPostgres();
        await db.$connect();
    });
    beforeEach(() => {
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME', '1');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await db.account.deleteMany({ where: { id: { in: accountIds.splice(0) } } });
    });
    afterAll(async () => { await db.$disconnect(); });

    async function pair() {
        const stem = randomUUID();
        const rows = await Promise.all(['a', 'z'].map(suffix => db.account.create({ data: {
            id: `${stem}-${suffix}`, username: `friend-${stem}-${suffix}`, encryptionMode: 'plain',
        } })));
        accountIds.push(...rows.map(row => row.id));
        return rows;
    }
    async function states() {
        return db.userRelationship.findMany({ where: { fromUserId: { in: accountIds } }, orderBy: { fromUserId: 'asc' },
            select: { status: true, lastNotifiedAt: true } });
    }

    it.each(['request', 'remove'] as const)('commits %s across a hot Account cursor without transaction recovery', async operation => {
        const [first, second] = await pair();
        if (operation === 'remove') await db.userRelationship.createMany({ data: [
            { fromUserId: first.id, toUserId: second.id, status: 'friend' },
            { fromUserId: second.id, toUserId: first.id, status: 'friend' },
        ] });
        const result = await acrossAccountCursorCommit(first.id, () => operation === 'request'
            ? friendAdd(Context.create(second.id), first.id) : friendRemove(Context.create(second.id), first.id));
        expect(result).toMatchObject({ id: first.id, status: operation === 'request' ? 'requested' : 'none' });
        expect((await states()).map(row => row.status)).toEqual(operation === 'request' ? ['pending', 'requested'] : ['none', 'none']);
        expect(await db.accountChange.count({ where: { accountId: { in: accountIds }, kind: 'friends' } })).toBe(2);
    });

    it.each(['reciprocal_request', 'accept_then_remove'] as const)('serializes %s and preserves notification cooldown', async scenario => {
        const [first, second] = await pair();
        const previousNotification = new Date();
        if (scenario === 'accept_then_remove') await db.userRelationship.createMany({ data: [
            { fromUserId: first.id, toUserId: second.id, status: 'requested' },
            { fromUserId: second.id, toUserId: first.id, status: 'pending', lastNotifiedAt: previousNotification },
        ] });
        const read = databaseLatch(), resume = databaseLatch();
        const original = db.$transaction;
        let firstPid = 0;
        let paused = false;
        // Interleave genuine database reads; both relationship/state-machine and
        // notification owners execute unchanged against PostgreSQL.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                firstPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'userRelationship') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.userRelationship, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: Parameters<typeof model.findUnique>) => {
                            const result = await model.findUnique(...queryArgs);
                            const key = queryArgs[0].where.fromUserId_toUserId;
                            const lastFrom = scenario === 'reciprocal_request' ? second.id : first.id;
                            if (!paused && key?.fromUserId === lastFrom) {
                                paused = true;
                                read.release();
                                await resume.promise;
                            }
                            return result;
                        };
                    } });
                } }));
            }, ...args.slice(1)]);
        } });
        const firstOperation = scenario === 'reciprocal_request'
            ? friendAdd(Context.create(first.id), second.id) : friendAdd(Context.create(second.id), first.id);
        const firstOutcome = Promise.allSettled([firstOperation]);
        let secondOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof friendAdd>>>[]> | undefined;
        try {
            await Promise.race([read.promise, firstOperation.then(() => { throw new Error('First operation bypassed reciprocal reads'); })]);
            db.$transaction = original;
            const secondOperation = scenario === 'reciprocal_request'
                ? friendAdd(Context.create(second.id), first.id) : friendRemove(Context.create(first.id), second.id);
            secondOutcome = Promise.allSettled([secondOperation]);
            await expect.poll(async () => {
                const blocked = await db.$queryRawUnsafe<Array<{ query: string }>>(
                    'SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', firstPid,
                );
                return blocked.some(row => /Account.*FOR NO KEY UPDATE/s.test(row.query));
            }).toBe(true);
            resume.release();
            for (const result of [...await firstOutcome, ...await secondOutcome]) {
                if (result.status === 'rejected') throw result.reason;
            }
            const relationships = await states();
            expect(relationships.map(row => row.status)).toEqual(scenario === 'reciprocal_request' ? ['friend', 'friend'] : ['none', 'none']);
            expect(await db.userFeedItem.count({ where: { userId: { in: accountIds } } })).toBe(scenario === 'reciprocal_request' ? 2 : 1);
            const cooldown = relationships[1].lastNotifiedAt;
            expect(cooldown).not.toBeNull();
            if (scenario === 'accept_then_remove') expect(cooldown).toEqual(previousNotification);
            else {
                await friendAdd(Context.create(first.id), second.id);
                expect((await states())[1].lastNotifiedAt).toEqual(cooldown);
                expect(await db.userFeedItem.count({ where: { userId: { in: accountIds } } })).toBe(2);
            }
        } finally {
            db.$transaction = original;
            resume.release();
            await firstOutcome;
            await secondOutcome;
        }
    });
});
