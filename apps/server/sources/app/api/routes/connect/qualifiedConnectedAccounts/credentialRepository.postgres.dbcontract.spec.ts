import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedServiceCredentialStoredMetadataV4 } from '../credentialHealthMetadata';
import { initEncrypt } from '@/modules/encrypt';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { mutateQualifiedConnectedServiceCredential, mutateQualifiedConnectedServiceCredentialHealth, readQualifiedConnectedServiceCredential } from './credentialRepository';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Connected Account revoke PostgreSQL contention', () => {
    let previousMasterSecret: string | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET ??= 'perf-start-cont13-disposable-contract';
        await initEncrypt();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    });

    it.each(['current', 'Serializable'] as const)('health publication under foreign tuple writes at %s isolation', async isolation => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ref = { service: { pluginId: 'fixture.health', localId: 'oauth' }, accountId: 'foreign-health-writer' };
        const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'oauth',
            content: { t: 'plain', v: { fixture: true } }, metadata: { scopes: [] } });
        if (created.status !== 'written') throw new Error('Expected fixture credential');
        const before = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } });
        const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
        const health = { v: 1 as const, status: 'needs_reauth' as const, reconnectRequired: true, providerErrorCode: 'invalid_grant' };
        const transaction = db.$transaction;
        let foreignWrites = 0;
        // Observe the real database boundary. The peer changes PostgreSQL tuple
        // identity without changing the application's updatedAt CAS or payload.
        // Serializable is a historical-isolation sensitivity probe, not a second
        // production owner; all callback logic and SQL execute unchanged.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            const options = args[1] as { isolationLevel?: string } | undefined;
            const probeOptions = isolation === 'Serializable' && options?.isolationLevel === 'ReadCommitted'
                ? { ...options, isolationLevel: 'Serializable' } : options;
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'serviceAccountToken') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.serviceAccountToken, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'updateMany') return operation;
                    return async (...queryArgs: Parameters<typeof tx.serviceAccountToken.updateMany>) => {
                        if (queryArgs[0]?.where?.id === before.id) {
                            await db.$executeRaw`UPDATE "ServiceAccountToken" SET "token" = "token" WHERE "id" = ${before.id}`;
                            foreignWrites++;
                        }
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
            } })), probeOptions]);
        } });
        try {
            await withAuthenticatedTestApp(app => registerQualifiedConnectedAccountCredentialRoutesV4(app), async app => {
                const payload = { ref, expectedCredentialRevision: created.credentialRevision,
                    expectedConfigurationRevision: created.configurationRevision, health };
                const response = await app.inject({ method: 'PATCH', url: '/v4/connect/qualified/credential/health',
                    headers: { 'x-test-user-id': account.id }, payload });
                console.info('CREDENTIAL_HEALTH_FOREIGN_TUPLE_CONTENTION', { isolation, foreignWrites, statusCode: response.statusCode });
                if (isolation === 'Serializable') {
                    expect(response.statusCode).toBe(503);
                    expect(response.json()).toMatchObject({ error: 'database_transaction_conflict_exhausted' });
                    expect(foreignWrites).toBe(readDatabaseTransactionConfigFromEnv(process.env, 'postgres').maxRetries + 1);
                    expect(await db.serviceAccountToken.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
                    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor);
                    return;
                }
                expect(response.statusCode).toBe(200);
                expect(QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(response.json())).toEqual({
                    success: true, credentialRevision: created.credentialRevision, configurationRevision: created.configurationRevision,
                });
                expect(foreignWrites).toBe(1);
                const query = new URLSearchParams({ ref: JSON.stringify(ref) });
                const read = await app.inject({ method: 'GET', url: `/v4/connect/qualified/credential?${query}`,
                    headers: { 'x-test-user-id': account.id } });
                expect(read.statusCode).toBe(200);
                expect(QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(read.json())).toMatchObject({ ref, metadata: { scopes: [] } });
                const list = await app.inject({ method: 'GET',
                    url: `/v4/connect/qualified/accounts?${new URLSearchParams({ service: JSON.stringify(ref.service) })}`,
                    headers: { 'x-test-user-id': account.id } });
                expect(list.statusCode).toBe(200);
                expect(QualifiedConnectedAccountListResponseV4Schema.parse(list.json()).accounts)
                    .toContainEqual(expect.objectContaining({ ref, status: 'needs_reauth' }));
                const stored = await db.serviceAccountToken.findUniqueOrThrow({ where: { id: before.id } });
                expect(parseQualifiedConnectedServiceCredentialStoredMetadataV4(stored.metadata).health).toEqual(health);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor + 1);
                const crossedAccount = await app.inject({ method: 'PATCH', url: '/v4/connect/qualified/credential/health',
                    headers: { 'x-test-user-id': outsider.id }, payload });
                expect(crossedAccount.statusCode).toBe(404);
                expect(crossedAccount.json()).toEqual({ error: 'connect_credential_not_found' });
            });
        } finally { db.$transaction = transaction; }
    });

    it('acknowledges equal health without waiting for an unrelated Account writer or publishing another cursor', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ref = { service: { pluginId: 'fixture.health', localId: 'oauth' }, accountId: 'equal-health' };
        const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'oauth',
            content: { t: 'plain', v: { fixture: true } }, metadata: { scopes: [] } });
        if (created.status !== 'written') throw new Error('Expected fixture credential');
        const params = { accountId: account.id, ref, expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            health: { v: 1 as const, status: 'needs_reauth' as const, reconnectRequired: true, providerErrorCode: 'invalid_grant' } };
        await expect(mutateQualifiedConnectedServiceCredentialHealth(params)).resolves.toEqual(created);
        const before = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } });
        const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
        let request: ReturnType<typeof mutateQualifiedConnectedServiceCredentialHealth> | undefined;
        let blocked = false;
        let completed = false;
        await db.$transaction(async peer => {
            const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            request = mutateQualifiedConnectedServiceCredentialHealth(params).finally(() => { completed = true; });
            void request.catch(() => undefined);
            // Observe actual PostgreSQL contention, not a timing threshold.
            while (!completed) {
                const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                `;
                if (waiting) { blocked = true; break; }
            }
        });
        await expect(request).resolves.toEqual(created);
        expect(blocked, 'An equal-health acknowledgement has no Account cursor to publish').toBe(false);
        expect(await db.serviceAccountToken.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor + 1);
        await expect(mutateQualifiedConnectedServiceCredentialHealth({ ...params,
            expectedCredentialRevision: 'replaced-credential' })).resolves.toMatchObject({ status: 'superseded' });
        await db.account.update({ where: { id: account.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        await expect(mutateQualifiedConnectedServiceCredentialHealth(params)).resolves.toEqual({ status: 'storage_mode_mismatch' });
    });

    it('rechecks changed health after an Account mode writer commits instead of publishing stale metadata', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ref = { service: { pluginId: 'fixture.health', localId: 'oauth' }, accountId: 'changed-health' };
        const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'oauth',
            content: { t: 'plain', v: { fixture: true } }, metadata: { scopes: [] } });
        if (created.status !== 'written') throw new Error('Expected fixture credential');
        const before = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } });
        const beforeCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
        let request: ReturnType<typeof mutateQualifiedConnectedServiceCredentialHealth> | undefined;
        let blocked = false;
        let completed = false;
        await db.$transaction(async peer => {
            const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await peer.account.update({ where: { id: account.id },
                data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
            request = mutateQualifiedConnectedServiceCredentialHealth({ accountId: account.id, ref,
                expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: created.configurationRevision,
                health: { v: 1, status: 'needs_reauth', reconnectRequired: true } }).finally(() => { completed = true; });
            void request.catch(() => undefined);
            while (!completed) {
                const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                        AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
                `;
                if (waiting) { blocked = true; break; }
            }
        });
        await expect(request).resolves.toEqual({ status: 'storage_mode_mismatch' });
        expect(blocked, 'A changed-health publication retains the Account fence').toBe(true);
        expect(await db.serviceAccountToken.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(beforeCursor);
    });

    it.each(['cursor', 'mode'] as const)('re-admits the credential after waiting for an Account %s writer without a serialization replay', async change => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ref = { service: { pluginId: 'fixture.revoke', localId: 'oauth' }, accountId: 'owned-revoke' };
        const written = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'oauth',
            content: { t: 'plain', v: { fixture: true } }, metadata: { scopes: [] } });
        if (written.status !== 'written') throw new Error('Expected fixture credential');
        const transaction = db.$transaction;
        let attempts = 0;
        let waited = false;
        let pendingPeer: Promise<unknown> | undefined;
        const release = deferred();
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                attempts++;
                if (attempts !== 1) return callback(tx);
                const locked = deferred();
                pendingPeer = Reflect.apply(transaction, db, [async (peer: Tx) => {
                    await peer.account.update({ where: { id: account.id }, data: change === 'cursor'
                        ? { seq: { increment: 1 } }
                        : { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
                    locked.resolve();
                    await release.promise;
                }]) as Promise<unknown>;
                await locked.promise;
                const pending = callback(tx);
                try {
                    for (;;) {
                        const rows = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                AND wait_event_type = 'Lock' AND query LIKE '%Account%') AS waiting`,
                        );
                        if (rows[0]?.waiting) { waited = true; break; }
                    }
                } finally { release.resolve(); }
                await pendingPeer;
                return pending;
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => registerQualifiedConnectedAccountCredentialRoutesV4(app), async app => {
                const query = new URLSearchParams({ ref: JSON.stringify(ref), expectedCredentialRevision: written.credentialRevision,
                    cleanupGroupReferences: 'true' });
                const response = await app.inject({ method: 'DELETE', url: `/v4/connect/qualified/credential?${query}`,
                    headers: { 'x-test-user-id': account.id } });
                console.info('CONNECTED_ACCOUNT_REVOKE_CONTENTION', { change, waited, attempts, statusCode: response.statusCode });
                expect(response.statusCode).toBe(change === 'cursor' ? 200 : 400);
                expect(response.json()).toEqual(change === 'cursor' ? { success: true } : { error: 'invalid-params' });
                expect(waited).toBe(true);
                expect(attempts).toBe(1);
            });
        } finally {
            release.resolve();
            db.$transaction = transaction;
            await pendingPeer;
        }
        expect((await readQualifiedConnectedServiceCredential({ accountId: account.id, ref })).status)
            .toBe(change === 'cursor' ? 'not_found' : 'storage_mode_mismatch');
    });
});
