import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import type { Fastify } from '@/app/api/types';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { McpServerCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { registerMcpServerCatalogRoutes } from './registerMcpServerCatalogRoutes';

const route = '/v1/account/entity-rows/mcp';
const content = { t: 'plain' as const, v: { v: 1 as const, servers: [], bindings: [] } };
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('MCP catalog PostgreSQL Account contention', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['cursor', 'mode'] as const)('uses the committed Account state after waiting for a %s writer', async change => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const transaction = db.$transaction;
        let attempts = 0;
        let lockWaits = 0;
        const failures: string[] = [];
        // Substitute only the database transport to schedule a genuine peer
        // transaction. The route, Account fence, envelope admission and CAS run unchanged.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let interleaved = false;
                return callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (interleaved || !query.includes('FROM "Account"') || !query.includes('FOR UPDATE') || values[0] !== account.id) {
                            return inner.$queryRawUnsafe(query, ...values);
                        }
                        interleaved = true;
                        attempts++;
                        const locked = deferred(), release = deferred();
                        const peer = Reflect.apply(transaction, db, [async (peerTx: Tx) => {
                            await peerTx.account.update({ where: { id: account.id }, data: change === 'cursor'
                                ? { seq: { increment: 1 } }
                                : { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
                            locked.resolve();
                            await release.promise;
                        }]) as Promise<unknown>;
                        await locked.promise;
                        // Prisma raw-query promises dispatch only when consumed.
                        const waiting = Promise.resolve(inner.$queryRawUnsafe(query, ...values));
                        // Observe a real lock wait rather than assume scheduling from a sleep.
                        try {
                            for (;;) {
                                const rows = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND wait_event_type = 'Lock' AND query LIKE '%FROM "Account"%FOR UPDATE%') AS waiting`,
                                );
                                if (rows[0]?.waiting) { lockWaits++; break; }
                            }
                        } finally { release.resolve(); }
                        await peer;
                        try { return await waiting; }
                        catch (error) {
                            const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
                            failures.push(code);
                            throw error;
                        }
                    };
                },
            }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
                const response = await app.inject({ method: 'POST', url: route,
                    headers: { 'x-test-user-id': account.id },
                    payload: { expectedRevision: 'absent', sourceSettingsVersion: 0, content } });
                console.info('MCP_ACCOUNT_CONTENTION', { change, attempts, lockWaits, failures, statusCode: response.statusCode });
                expect(response.statusCode).toBe(200);
                expect(McpServerCatalogRowMutationResponseV1Schema.parse(response.json())).toMatchObject(change === 'cursor'
                    ? { status: 'updated', revision: 0 }
                    : { status: 'account-mode-mismatch' });
                expect(lockWaits).toBeGreaterThan(0);
                expect(failures).toEqual([]);
            });
        } finally { db.$transaction = transaction; }
        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(change === 'cursor' ? 1 : 0);
    });

    it('keeps catalog CAS authoritative for two writers of the same revision', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
            const headers = { 'x-test-user-id': account.id };
            const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: route, headers,
                payload: { expectedRevision: 'absent', sourceSettingsVersion: 0, content } })));
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(responses.map(response => response.json().status).sort()).toEqual(['conflict', 'updated']);
            const read = await app.inject({ method: 'GET', url: route, headers });
            expect(read.json()).toEqual({ status: 'present', revision: 0, content });
        });
    });

    it('reads Account mode and catalog from one snapshot while a mode transition commits', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const row = await db.userKVStore.create({ data: { accountId: account.id,
            key: '@happier/account/mcp/v1/catalog', version: 0,
            value: new TextEncoder().encode(JSON.stringify(content)) } });
        const transaction = db.$transaction;
        let advanced = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== 'account') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.account, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findUnique') return operation;
                        return async (...queryArgs: Parameters<typeof tx.account.findUnique>) => {
                            const captured = await Reflect.apply(operation, delegate, queryArgs);
                            if (!advanced && queryArgs[0]?.where.id === account.id) {
                                advanced = true;
                                await Reflect.apply(transaction, db, [async (peerTx: Tx) => {
                                    await peerTx.account.update({ where: { id: account.id },
                                        data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
                                    await peerTx.userKVStore.update({ where: { id: row.id }, data: { version: 1,
                                        value: new TextEncoder().encode(JSON.stringify({ t: 'encrypted', c: 'opaque' })) } });
                                }]);
                            }
                            return captured;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => registerMcpServerCatalogRoutes(app as unknown as Fastify), async app => {
                const response = await app.inject({ method: 'GET', url: route, headers: { 'x-test-user-id': account.id } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ status: 'present', revision: 0, content });
                expect(advanced).toBe(true);
            });
        } finally { db.$transaction = transaction; }
        expect((await db.userKVStore.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(1);
    });
});
