import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { buildSessionFollowRulePhysicalKeyV1, SessionFollowRuleStoredRowV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { inReadSnapshot } from '@/storage/inTx';
import { listAccountFollowRuleRowsInTx } from './accountFollowRuleService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session receiver census physical SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); });

    it.each([1, 4, 1100])('hydrates %i rich legacy rules with set-oriented physical SQL', async count => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createdAt = new Date(1234);
        await db.userKVStore.createMany({ data: Array.from({ length: count }, () => ({
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1(randomUUID()), version: 1, createdAt,
            value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                version: 1, receiver: { kind: 'account' },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            }))),
        })) });
        const originalTransaction = db.$transaction;
        const traced = client!;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            statements.length = 0;
            const listed = await inReadSnapshot(tx => listAccountFollowRuleRowsInTx(tx, { accountId: owner.id }));
            expect(listed.status).toBe('listed');
            if (listed.status !== 'listed') throw new Error('Expected retained rules');
            expect(listed.rows).toHaveLength(count);
            expect(listed.rows.every(row => row.envelope?.inception?.createdAt === createdAt.getTime())).toBe(true);
            const selects = statements.filter(event => /^SELECT\b/.test(event.query));
            expect(selects).toHaveLength(count > 997 ? 4 : 3);
        } finally { db.$transaction = originalTransaction; }
    });

    it('does not add SQL statements per retained rule to one Session detail request', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const addRule = () => db.userKVStore.create({ data: {
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1(randomUUID()), version: 1,
            value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                version: 1, receiver: { kind: 'session', sessionId: session.id },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            }))),
        } });
        const originalTransaction = db.$transaction;
        const traced = client!;
        // Observe engine-emitted SQL; only the persistent database transport changes.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
                const request = { method: 'GET' as const, url: `/v2/sessions/${session.id}?accessProjectionVersion=1`,
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } };
                expect((await app.inject(request)).statusCode).toBe(200);
                const measure = async (rules: number) => {
                    statements.length = 0;
                    const response = await app.inject(request);
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json().session.id).toBe(session.id);
                    expect(response.json().session.receivedRuleCount).toBe(rules);
                    const selects = statements.filter(event => /^SELECT\b/.test(event.query));
                    return { rules, statements: statements.length, selects: selects.length,
                        inceptionReads: selects.filter(event => /FROM "public"\."UserKVStore"(?:\s|$)/.test(event.query)
                            && event.query.includes('"createdAt"')).length };
                };
                await addRule();
                const one = await measure(1);
                await Promise.all(Array.from({ length: 3 }, addRule));
                const many = await measure(4);
                expect(many.selects).toBe(one.selects);
                expect(many.inceptionReads).toBe(0);
            });
        } finally { db.$transaction = originalTransaction; }
    });
});
