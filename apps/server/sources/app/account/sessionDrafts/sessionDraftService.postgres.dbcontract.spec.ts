import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    SESSION_DRAFT_ROUTE_MUTATE, SESSION_DRAFT_ROUTE_READ,
    SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ,
    SessionDraftMutateResponseV1Schema, SessionDraftReadResponseV1Schema,
    SessionDraftMutateResponseV2Schema, SessionDraftReadResponseV2Schema,
} from '@happier-dev/protocol';

import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { registerSessionDraftRoutes } from './registerSessionDraftRoutes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('draft mutation PostgreSQL contention', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it.each([
        { mutateUrl: SESSION_DRAFT_ROUTE_MUTATE, readUrl: SESSION_DRAFT_ROUTE_READ,
            mutateSchema: SessionDraftMutateResponseV1Schema, readSchema: SessionDraftReadResponseV1Schema },
        { mutateUrl: SESSION_DRAFT_V2_ROUTE_MUTATE, readUrl: SESSION_DRAFT_V2_ROUTE_READ,
            mutateSchema: SessionDraftMutateResponseV2Schema, readSchema: SessionDraftReadResponseV2Schema },
    ])('commits $mutateUrl despite continuing Account cursor publication, preserving CAS and Account binding', async ({ mutateUrl, readUrl, mutateSchema, readSchema }) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const address = { kind: 'newSession' as const, draftId: randomUUID() };
        const content = {
            t: 'plain' as const,
            v: { v: 1 as const, address, document: {
                v: 1 as const,
                composer: {
                    text: { mutationId: randomUUID(), value: 'retained under publication contention' },
                    mentions: { mutationId: randomUUID(), value: [] },
                    attachments: { mutationId: randomUUID(), value: [] },
                },
                target: { kind: 'newSession' as const, authoring: {} }, extensions: {},
            } },
        };
        const originalTransaction = db.$transaction;
        let peerPublications = 0;
        // Interleave a real independent Account publication after the draft's
        // existence read on every attempt. No internal decision is replaced.
        db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== 'account') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.account, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findUnique') return operation;
                        return async (...queryArgs: Parameters<typeof tx.account.findUnique>) => {
                            const row: unknown = await Reflect.apply(operation, delegate, queryArgs);
                            if (queryArgs[0]?.where.id === account.id && queryArgs[0]?.select?.id === true) {
                                await Reflect.apply(originalTransaction, db, [async (peer: Tx) => {
                                    await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                }]);
                                peerPublications++;
                            }
                            return row;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        try {
            await withAuthenticatedTestApp(registerSessionDraftRoutes, async app => {
                const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
                const response = await app.inject({ method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 'absent', content } });
                expect(response.statusCode, response.body).toBe(200);
                expect(mutateSchema.parse(response.json())).toMatchObject({ status: 'updated', record: { address, revision: 0, content } });
                expect(peerPublications).toBeGreaterThan(0);
                db.$transaction = originalTransaction;
                const read = await app.inject({ method: 'POST', url: readUrl, headers, payload: { address } });
                expect(read.statusCode, read.body).toBe(200);
                expect(readSchema.parse(read.json())).toMatchObject({ status: 'present', record: { revision: 0, content } });
                const stale = await app.inject({ method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 'absent', content: null } });
                expect(mutateSchema.parse(stale.json())).toMatchObject({ status: 'conflict', current: { revision: 0, content } });
                const contenders = await Promise.all([0, 1].map(() => app.inject({
                    method: 'POST', url: mutateUrl, headers,
                    payload: { address, expectedRevision: 0, content: null },
                })));
                for (const contender of contenders) expect(contender.statusCode, contender.body).toBe(200);
                expect(contenders.map(contender => mutateSchema.parse(contender.json()).status).sort()).toEqual(['conflict', 'updated']);
                const deleted = await app.inject({ method: 'POST', url: readUrl, headers, payload: { address } });
                expect(readSchema.parse(deleted.json())).toMatchObject({ status: 'deleted', record: { revision: 1, content: null } });
                // A route bound to the wrong authenticated Account cannot read
                // the producer's persisted draft, even with its exact address.
                const misbound = await app.inject({ method: 'POST', url: readUrl,
                    headers: { ...headers, 'x-test-user-id': stranger.id }, payload: { address } });
                expect(readSchema.parse(misbound.json())).toEqual({ status: 'absent' });
            });
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.account.deleteMany({ where: { id: { in: [account.id, stranger.id] } } });
        }
    });
});
