import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { updatePendingMessage } from '@/app/session/pending/pendingMessageService';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

import { deleteAccountForErasure } from './accountDataErase';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

type BlockingBackend = Readonly<{ pid: number; query: string; blockers: number[] }>;

async function readBackendsBlockedBy(pid: number): Promise<BlockingBackend[]> {
    return db.$queryRawUnsafe<BlockingBackend[]>(
        'SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity '
        + 'WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))',
        pid,
    );
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account erasure terminal tail', () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    const previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('A disposable PostgreSQL contract DATABASE_URL is required');
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await shutdownDbClient();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        if (previousStoragePolicy === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
    });

    it('orders a surviving owner editing a retired member\'s Pending row before physical erasure', async () => {
        const fixtureId = randomUUID();
        const erasedAccountId = `a-erased-${fixtureId}`;
        const ownerAccountId = `z-surviving-${fixtureId}`;
        await db.account.createMany({ data: [
            { id: erasedAccountId, encryptionMode: 'plain', status: 'disabled' },
            { id: ownerAccountId, encryptionMode: 'plain' },
        ] });
        const sharedSession = await db.session.create({ data: {
            accountId: ownerAccountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
            pendingCount: 1, pendingQueueSeq: 1,
        } });
        // This owned resource makes erasure publish a real removal for its own
        // Account before that Account and its change rows cascade away.
        const erasedSession = await db.session.create({ data: {
            accountId: erasedAccountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        await db.sessionShare.create({ data: {
            sessionId: sharedSession.id, sharedByUserId: ownerAccountId,
            sharedWithUserId: erasedAccountId, accessLevel: 'edit',
        } });
        const localId = randomUUID();
        await db.sessionPendingMessage.create({ data: {
            sessionId: sharedSession.id, localId, authorAccountId: erasedAccountId,
            messageRole: 'user', position: 1, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Retained draft' } } },
        } });
        const editedContent = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Edited by surviving owner' } } } as const;
        const resourceLocked = deferred();
        const releaseResource = deferred();
        let resourcePid = 0;
        let writerFinished = false;
        let erasureFinished = false;
        let writerOutcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof updatePendingMessage>>>[]> | undefined;
        let erasureOutcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof deleteAccountForErasure>>>[]> | undefined;
        // This fixture-only SQL barrier never replaces a production writer. It
        // positions the public Pending editor after admission, before Session work.
        const holderOutcomes = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            resourcePid = backend.pid;
            await tx.$queryRawUnsafe('SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE', sharedSession.id);
            resourceLocked.resolve();
            await releaseResource.promise;
        })]);

        try {
            const census = await inReadSnapshot(tx => readSessionAccountCursorAudienceInTx(tx, [sharedSession.id], []));
            // Retired members still own attribution rows touched by Account FK
            // actions. They must remain in admission even though publication
            // and content disclosure exclude inactive recipients.
            expect(census.accountIds).toEqual([erasedAccountId, ownerAccountId]);
            await Promise.race([resourceLocked.promise, holderOutcomes.then(() => {
                throw new Error('Session resource barrier ended before acquisition');
            })]);
            writerOutcomes = Promise.allSettled([updatePendingMessage({
                actorUserId: ownerAccountId, sessionId: sharedSession.id, localId,
                authentication: createPresentUserSessionAccessAuthentication(), messageRole: 'user', content: editedContent,
            })]).then(outcomes => { writerFinished = true; return outcomes; });

            let writer: BlockingBackend | undefined;
            while (!writerFinished && !writer) [writer] = await readBackendsBlockedBy(resourcePid);
            expect(writer, 'the real Pending editor must wait at the Session resource after Account admission').toBeDefined();
            if (!writer) throw new Error('Pending editor ended before reaching the Session resource');
            expect(writer.query).toContain('Session');
            // Before erasure starts, the only Account-lock holder is the real
            // Pending editor. NOWAIT observes its protection of the inactive
            // author specifically, not an incidental surviving-owner fence.
            await expect(db.$transaction(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', erasedAccountId,
            ))).rejects.toMatchObject({ meta: { code: '55P03' } });

            erasureOutcomes = Promise.allSettled([deleteAccountForErasure({ accountId: erasedAccountId })])
                .then(outcomes => { erasureFinished = true; return outcomes; });
            let erasure: BlockingBackend | undefined;
            while (!erasureFinished && !erasure) [erasure] = await readBackendsBlockedBy(writer.pid);
            expect(erasure, 'exclusive erasure must wait for the ordinary writer before touching Session resources').toBeDefined();
            if (!erasure) throw new Error('Erasure ended before exclusive admission was observed');
            expect(erasure.query).toContain('Account');
            expect(erasure.query).toContain('FOR UPDATE');

            // No grant-removal or attribution cascade can become visible while
            // the other Account's complete entry cohort is holding erasure out.
            expect(await db.sessionShare.count({ where: { sessionId: sharedSession.id, sharedWithUserId: erasedAccountId } })).toBe(1);
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: sharedSession.id, localId } },
                select: { authorAccountId: true } })).toEqual({ authorAccountId: erasedAccountId });

            releaseResource.resolve();
            const [writerOutcome] = await writerOutcomes;
            const [erasureOutcome] = await erasureOutcomes;
            console.info('account-erasure-shared-pending-order', {
                resourcePid, writerPid: writer.pid, writerBlockers: writer.blockers,
                erasurePid: erasure.pid, erasureBlockers: erasure.blockers,
                writerStatus: writerOutcome.status, erasureStatus: erasureOutcome.status, retries: 0,
                writerResult: writerOutcome.status === 'fulfilled' ? writerOutcome.value : undefined,
                erasureError: erasureOutcome.status === 'rejected' ? String(erasureOutcome.reason) : undefined,
            });
            if (writerOutcome.status === 'rejected') throw writerOutcome.reason;
            expect(writerOutcome.value).toMatchObject({ ok: true });
            if (erasureOutcome.status === 'rejected') throw erasureOutcome.reason;
            expect(erasureOutcome.value).toEqual({ status: 'deleted' });
            expect(await db.account.findUnique({ where: { id: erasedAccountId } })).toBeNull();
            expect(await db.session.findUnique({ where: { id: erasedSession.id } })).toBeNull();
            expect(await db.session.findUniqueOrThrow({ where: { id: sharedSession.id }, select: { accountId: true } }))
                .toEqual({ accountId: ownerAccountId });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: sharedSession.id, localId } },
                select: { authorAccountId: true, content: true } })).toEqual({ authorAccountId: null, content: editedContent });
            expect(await db.sessionShare.count({ where: { sessionId: sharedSession.id, sharedWithUserId: erasedAccountId } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: ownerAccountId, entityId: sharedSession.id } })).toBeGreaterThan(0);
        } finally {
            releaseResource.resolve();
            await holderOutcomes;
            await writerOutcomes;
            await erasureOutcomes;
            await db.session.deleteMany({ where: { id: { in: [sharedSession.id, erasedSession.id] } } });
            await db.account.deleteMany({ where: { id: { in: [erasedAccountId, ownerAccountId] } } });
        }
    });
});
