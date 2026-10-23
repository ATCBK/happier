import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';

import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session detail physical SQL work (PostgreSQL)', () => {
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
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
    });
    afterAll(async () => {
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it.each([false, true])('admits the loaded detail row once with manager relation=%s', async hasManager => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const manager = hasManager ? await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } }) : null;
        if (manager) await db.sessionFollowEdge.create({ data: {
            sourceSessionId: session.id, destinationSessionId: manager.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
            relation: 'manager', managerSourceSessionId: session.id, policyJson: JSON.stringify({ preset: 'important' }),
        } });
        const originalTransaction = db.$transaction;
        const tracedClient = client!;
        // Rebind only the database transport to observe engine-emitted SQL.
        // The real transaction, admission and projection owners still run.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(tracedClient.$transaction, tracedClient, args);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionListingRoutes(app);
                registerSessionReadBatchRoute(app);
            }, async app => {
                const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
                const reads = [
                    { method: 'GET' as const, url: `/v2/sessions/${session.id}` },
                    { method: 'GET' as const, url: `/v2/sessions/${session.id}?accessProjectionVersion=1` },
                    { method: 'POST' as const, url: '/v2/sessions/read-batch', payload: {
                        sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false,
                    } },
                ];
                const measurements: Array<{ statements: number; sessionReads: number; sessionRows: number }> = [];
                // Exclude one-time connection initialization from request work.
                for (const request of reads) expect((await app.inject({ ...request, headers })).statusCode).toBe(200);
                for (const request of reads) {
                    statements.length = 0;
                    const response = await app.inject({ ...request, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    const expected = { session: { id: session.id, ...(manager ? { manager: { sessionId: manager.id } } : {}) } };
                    if (request.method === 'POST') {
                        expect(SessionReadBatchResponseV1Schema.parse(response.json()).results[0]?.detail)
                            .toMatchObject({ status: 200, body: expected });
                    } else expect(response.json()).toMatchObject(expected);
                    const captured = statements.slice();
                    const sessionReads = captured.filter(({ query }) => /^SELECT\b/.test(query)
                        && /FROM "public"\."Session"(?:\s|$)/.test(query));
                    // Fixtures remain unchanged: replay SELECTs to count the rows
                    // actually returned by each physical Session query, not ORM calls.
                    let sessionRows = 0;
                    for (const { query, params } of sessionReads) {
                        const values: unknown[] = JSON.parse(params);
                        sessionRows += (await db.$queryRawUnsafe<unknown[]>(query, ...values)).length;
                    }
                    measurements.push({ statements: captured.length, sessionReads: sessionReads.length, sessionRows });
                }
                expect(measurements[0]!.sessionRows).toBeGreaterThan(0);
                // Current detail needs no extra capture-phase access read: its row
                // already carries the same canonical access projection as legacy.
                expect(measurements[1]!.sessionReads).toBe(measurements[0]!.sessionReads);
                expect(measurements[1]!.sessionRows).toBe(measurements[0]!.sessionRows);
                // With no related endpoints there is no collective-access
                // demand. Real relations retain their qualified current reads.
                if (!hasManager) expect(measurements[1]!.statements).toBe(measurements[0]!.statements);
                expect(measurements[2]).toEqual(measurements[1]);
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it.each(['GET', 'POST'] as const)('refuses %s detail when direct access is revoked after capture commits', async method => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), currentStorageState: 'hosted',
        } });
        const share = await db.sessionShare.create({ data: {
            sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: 'view',
        } });
        const originalTransaction = db.$transaction;
        try {
            await withAuthenticatedTestApp(app => {
                registerSessionListingRoutes(app);
                registerSessionReadBatchRoute(app);
            }, async app => {
                const request = {
                    headers: { 'x-test-user-id': viewer.id, 'x-happier-account-stored-content-protocol': '4' },
                    ...(method === 'GET'
                        ? { method, url: `/v2/sessions/${session.id}?accessProjectionVersion=1` }
                        : { method, url: '/v2/sessions/read-batch', payload: {
                            sessionIds: [session.id], accessProjectionVersion: 1, includeTurns: false,
                        } }),
                };
                const detail = (response: Readonly<{ statusCode: number; json(): unknown }>) => method === 'GET'
                    ? { status: response.statusCode, body: response.json() }
                    : SessionReadBatchResponseV1Schema.parse(response.json()).results[0]?.detail;
                expect(detail(await app.inject(request))).toMatchObject({ status: 200, body: { session: { id: session.id } } });
                let revoked = false;
                // Commit a real concurrent revocation between the two real
                // transaction phases, without mocking any access decision.
                db.$transaction = new Proxy(originalTransaction, { async apply(target, receiver, args) {
                    const result: unknown = await Reflect.apply(target, receiver, args);
                    if (!revoked) {
                        revoked = true;
                        await db.sessionShare.delete({ where: { id: share.id } });
                    }
                    return result;
                } });
                expect(detail(await app.inject(request))).toEqual({ status: 404, body: { error: 'Session not found' } });
                expect(revoked).toBe(true);
            });
        } finally {
            db.$transaction = originalTransaction;
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });
});
