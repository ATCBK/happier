// Research only: candidate falsification and synthetic critical-section comparison.
// No production owner is replaced; run only with the disposable Docker DB runner.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { db, initDbPostgres } from '../sources/storage/db';
import { inTx } from '../sources/storage/inTx';
import { markAccountChanged } from '../sources/app/changes/markAccountChanged';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '../sources/app/encryption/accountSessionOwnerMetadataFence';
import { changesRoutes } from '../sources/app/api/routes/changes/changesRoutes';
import { createAuthenticatedTestApp } from '../sources/app/api/testkit/sqliteFastify';

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function percentiles(values: number[]) {
    const ordered = [...values].sort((a, b) => a - b);
    return { min: ordered[0], median: ordered[Math.floor(ordered.length / 2)],
        p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1) };
}

describe('LOCKDESIGN challenger B disposable PostgreSQL experiments', () => {
    beforeAll(async () => {
        if (process.env.HAPPIER_DB_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) throw new Error('Disposable PostgreSQL runner required');
        // 100 submitted writers, at most 32 connected transactions; leave PG's
        // default max_connections unchanged. This is a harness setting only.
        process.env.HAPPIER_DB_CONNECTION_LIMIT = '32';
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('falsifies an unfenced sequence through the actual HTTP checkpoint reader', async () => {
        const account = await db.account.create({ data: { publicKey: `lockdesign-b-${randomUUID()}`, encryptionMode: 'plain', seq: 1000 } });
        const sequence = `lockdesign_b_${randomUUID().replaceAll('-', '')}`;
        await db.$executeRawUnsafe(`CREATE SEQUENCE "${sequence}"`);
        const allocated = latch();
        const release = latch();
        const first = inTx(async tx => {
            const [row] = await tx.$queryRawUnsafe<{ cursor: bigint }[]>('SELECT nextval($1::regclass) AS cursor', sequence);
            await tx.accountChange.create({ data: { accountId: account.id, kind: 'account', entityId: 'late-low', cursor: Number(row.cursor), changedAt: new Date() } });
            allocated.release();
            await release.promise;
        }, { isolationLevel: 'ReadCommitted' });
        const firstResult = Promise.allSettled([first]);
        const app = createAuthenticatedTestApp();
        changesRoutes(app);
        try {
            await allocated.promise;
            await inTx(async tx => {
                const [row] = await tx.$queryRawUnsafe<{ cursor: bigint }[]>('SELECT nextval($1::regclass) AS cursor', sequence);
                await tx.accountChange.create({ data: { accountId: account.id, kind: 'account', entityId: 'early-high', cursor: Number(row.cursor), changedAt: new Date() } });
            }, { isolationLevel: 'ReadCommitted' });
            const page = await app.inject({ method: 'GET', url: '/v2/changes?after=0&limit=7', headers: { 'x-test-user-id': account.id } });
            expect(page.statusCode).toBe(200);
            const body = ChangesResponseSchema.parse(page.json());
            expect(body.changes.map(row => row.entityId)).toEqual(['early-high']);
            expect(body.nextCursor).toBe(2);
            release.release();
            for (const result of await firstResult) if (result.status === 'rejected') throw result.reason;
            const next = await app.inject({ method: 'GET', url: `/v2/changes?after=${body.nextCursor}&limit=7`, headers: { 'x-test-user-id': account.id } });
            expect(next.statusCode).toBe(200);
            expect(ChangesResponseSchema.parse(next.json()).changes).toEqual([]);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(2);
            console.log('LOCKDESIGN_B_SEQUENCE', JSON.stringify({ checkpoint: body.nextCursor, durableRows: 2, lateLowDeliveredAfterCheckpoint: false }));
        } finally {
            release.release();
            await firstResult;
            await app.close();
        }
    });

    it('compares early exclusive, late publication, and key-share stability for 100 writers with real paged readers', async () => {
        for (const strategy of ['early-exclusive', 'late-publication', 'key-share-stability'] as const) {
            const account = await db.account.create({ data: { publicKey: `lockdesign-b-${randomUUID()}`, encryptionMode: 'plain' } });
            await db.session.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: `lockdesign-b-${randomUUID()}`, accountId: account.id, tag: `session-${i}`, metadata: '{}' })) });
            const sessions = await db.session.findMany({ where: { accountId: account.id }, select: { id: true } });
            const measurements: { admissionMs: number; firstLockMs: number; publishMs: number; holdMs: number; totalMs: number; waiters: number }[] = [];
            const app = createAuthenticatedTestApp();
            changesRoutes(app);
            let done = false;
            let checkpoint = 0;
            const observed = new Set<string>();
            const started = performance.now();
            const writers = Promise.allSettled(sessions.map(async session => {
                const submitted = performance.now();
                let entered = 0, lockStart = 0, lockGranted = 0, publishStart = 0, published = 0, waiters = 0;
                await inTx(async tx => {
                    entered = performance.now();
                    lockStart = performance.now();
                    if (strategy === 'early-exclusive') await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
                    if (strategy === 'key-share-stability') await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
                    lockGranted = performance.now();
                    const current = await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { encryptionMode: true } });
                    expect(current.encryptionMode).toBe('plain');
                    await tx.session.update({ where: { id: session.id }, data: { metadata: JSON.stringify({ research: strategy }) } });
                    // Deliberately synthetic 10ms domain phase: exposes the lock
                    // topology; it is not a measurement of Pending/Usage cost.
                    await tx.$queryRawUnsafe('SELECT 1 FROM pg_sleep(0.010)');
                    publishStart = performance.now();
                    await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id });
                    published = performance.now();
                    const [sample] = await tx.$queryRawUnsafe<{ waiters: bigint }[]>("SELECT count(*) AS waiters FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%Account%'");
                    waiters = Number(sample.waiters);
                }, { isolationLevel: 'ReadCommitted' });
                const settled = performance.now();
                measurements.push({ admissionMs: entered - submitted, firstLockMs: lockGranted - lockStart,
                    publishMs: published - publishStart, holdMs: settled - (strategy === 'late-publication' ? publishStart : lockGranted), totalMs: settled - submitted, waiters });
            })).finally(() => { done = true; });
            try {
                // Exercise the registered route while writers commit, then drain
                // every page. Strict consumer is the CLI/UI protocol schema.
                while (!done || checkpoint < 100) {
                    const doneBeforeRead = done;
                    const response = await app.inject({ method: 'GET', url: `/v2/changes?after=${checkpoint}&limit=7`, headers: { 'x-test-user-id': account.id } });
                    expect(response.statusCode).toBe(200);
                    const page = ChangesResponseSchema.parse(response.json());
                    for (const change of page.changes) {
                        expect(change.cursor).toBeGreaterThan(checkpoint);
                        observed.add(change.entityId);
                    }
                    expect(page.nextCursor).toBeGreaterThanOrEqual(checkpoint);
                    checkpoint = page.nextCursor;
                    // A request that began before the final commit may have
                    // already read an empty page when writers finish. Only an
                    // empty read begun after settlement can end the drain.
                    if (doneBeforeRead && page.changes.length === 0) break;
                }
                for (const result of await writers) if (result.status === 'rejected') throw result.reason;
                expect(measurements).toHaveLength(100);
                expect(observed.size).toBe(100);
                expect(checkpoint).toBe(100);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 100 });
                console.log('LOCKDESIGN_B_LOAD', JSON.stringify({ strategy, submittedWriters: 100, poolLimit: 32,
                    elapsedMs: performance.now() - started, delivered: observed.size, checkpoint,
                    maxAccountWaiters: Math.max(...measurements.map(row => row.waiters)),
                    admissionMs: percentiles(measurements.map(row => row.admissionMs)),
                    firstLockMs: percentiles(measurements.map(row => row.firstLockMs)),
                    publishMs: percentiles(measurements.map(row => row.publishMs)),
                    holdMs: percentiles(measurements.map(row => row.holdMs)),
                    totalMs: percentiles(measurements.map(row => row.totalMs)) }));
            } finally { await writers; await app.close(); }
        }
    }, 120_000);

    it('lets existing key-share holders publish while a rare exclusive transition waits', async () => {
        const account = await db.account.create({ data: { publicKey: `lockdesign-b-${randomUUID()}`, encryptionMode: 'plain' } });
        const go = latch();
        const ready = [latch(), latch()];
        const writers = ready.map((signal, i) => inTx(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
            signal.release();
            await go.promise;
            return markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: `writer-${i}` });
        }, { isolationLevel: 'ReadCommitted' }));
        const results = Promise.allSettled(writers);
        await Promise.all(ready.map(signal => signal.promise));
        let pid = 0;
        let settled = false;
        const transition = inTx(async tx => {
            const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
            pid = row.pid;
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            expect(await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
        }, { isolationLevel: 'ReadCommitted' });
        const transitionResult = Promise.allSettled([transition]).finally(() => { settled = true; });
        try {
            let blocked = false;
            while (!settled) {
                const [row] = await db.$queryRawUnsafe<{ blocked: boolean }[]>('SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked', pid);
                if (row.blocked) { blocked = true; break; }
            }
            expect(blocked).toBe(true);
        } finally { go.release(); }
        for (const result of [...await results, ...await transitionResult]) if (result.status === 'rejected') throw result.reason;
        console.log('LOCKDESIGN_B_TRANSITION', JSON.stringify({ sharedWritersCommitted: 2, exclusiveTransitionObservedSeq: 2, retries: 0 }));
    });
});
