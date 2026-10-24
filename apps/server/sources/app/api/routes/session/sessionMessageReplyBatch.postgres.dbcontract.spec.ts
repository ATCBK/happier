import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { PrismaClient } from '@prisma/client';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionMessageRepliesInTx, readSessionMessageReplyInTx } from '@/app/session/messages/sessionMessageReply';

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
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('keeps original acquisition SQL proportional to bound chunks rather than a thousand keys', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        const originalReads: string[] = [];
        reader.$on('query', event => {
            if (/^SELECT\b/.test(event.query) && /FROM "public"\."Session(?:Pending)?Message"/.test(event.query)) originalReads.push(event.query);
        });
        try {
            const sessions = await Promise.all(Array.from({ length: 3 }, () => db.session.create({ data: {
                accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
            } })));
            const requests = Array.from({ length: 1000 }, (_, index) => ({ sessionId: sessions[index % sessions.length]!.id, localId: `original-${index}` }));
            const progress = { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } };
            await db.sessionMessage.createMany({ data: requests.map((key, index) => ({ ...key, seq: index + 1, messageRole: 'user',
                content: { t: 'plain', v: { text: 'Question' } }, replyProgress: progress,
            })) });
            const authentication = createPresentUserSessionAccessAuthentication();
            const result = await reader.$transaction(tx => readSessionMessageRepliesInTx(tx, { accountId: account.id, authentication,
                requests: [...requests, { sessionId: sessions[0]!.id, localId: 'unavailable' }] }));
            expect(result).toHaveLength(1001);
            expect(result.slice(0, 1000).every(row => row.reply.status === 'available')).toBe(true);
            expect(result[1000]!.reply.status).toBe('unavailable');
            expect(originalReads.length).toBeGreaterThan(0);
            expect(originalReads.length).toBeLessThanOrEqual(6);
            const singleton = await reader.$transaction(tx => readSessionMessageReplyInTx(tx, { accountId: account.id, authentication, ...requests[0]! }));
            expect(singleton).toEqual(result[0]!.reply);
        } finally {
            await reader.$disconnect();
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
