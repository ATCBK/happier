import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('exact reply demand on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });
    it('reads only requested originals and leaves the durable reply unchanged', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const target = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            const progress = { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } };
            const original = await db.sessionMessage.create({ data: { sessionId: target.id, seq: 1, localId: 'original',
                messageRole: 'user', content: { t: 'plain', v: { text: 'Question' } }, replyProgress: progress } });
            await db.sessionMessage.create({ data: { sessionId: target.id, seq: 2, localId: 'unrelated', messageRole: 'user',
                content: { t: 'plain', v: { text: 'Unrelated' } }, replyProgress: { ...progress, outcome: { kind: 'failed' } } } });
            await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                    headers: { 'x-test-user-id': account.id }, payload: { requests: [{ sessionId: target.id, localId: 'original' }] } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ results: [{ sessionId: target.id, localId: 'original', reply: { v: 1, status: 'available', progress } }] });
            });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: original.id } })).replyProgress).toEqual(progress);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
