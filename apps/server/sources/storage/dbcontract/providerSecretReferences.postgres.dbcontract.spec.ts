import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema,
    ProviderConnectionsRowMutationResponseV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProviderConnectionsRoutes } from '@/app/account/providers/registerProviderConnectionsRoutes';
import { createSavedSecretResourceInTx, deleteSavedSecretResourceInTx, listSavedSecretResourcesForAccountInTx,
    setSavedSecretResourceGrantsInTx, updateSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { db, getDbProviderFromEnv, initDbPostgres, isPrismaErrorCode } from '@/storage/db';
import { inTx, isTransactionConflictExhaustedError, type Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { encodeSensitiveContentForAtRestStorage } from '@/app/encryption/sensitiveContentAtRestStorage';
import { mutateProfileRowsInTx } from '@/app/account/profiles/profileRows';
import { mutateProfileTransferInTx } from '@/app/account/profiles/profileTransferRows';
import { mutateAccountSettingsHistorySnapshotInTx } from '@/app/accountSettings/accountSettingsHistoryRepository';
import { buildProfilePhysicalKey, PROFILE_TRANSFER_ACCOUNT_KV_KEY } from '@/app/kv/accountScopedKv';
import { ProfileRowMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ProfileTransferMutationV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AccountSettingsV2HistoryMutationRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { deriveSavedSecretImportResourceIdV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Provider Secret reference read set (PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HANDY_MASTER_SECRET', 'c31-disposable-contract-master');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        connected = true;
        await initEncrypt();
        const paddingOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        // Keep the named and unrelated resources on distinct B-tree pages.
        // PostgreSQL can otherwise report a physical page conflict even for
        // point reads of two different keys in a tiny fresh table.
        await db.savedSecretResource.createMany({ data: Array.from({ length: 1024 }, (_, index) => {
            const id = `m-padding-${index.toString().padStart(4, '0')}`;
            return { id, ownerAccountId: paddingOwner.id, displayName: 'Padding', kind: 'token', encryptionMode: 'plain',
                storedContent: encodeSensitiveContentForAtRestStorage({ contentMode: 'plain',
                    keyPath: ['storage', 'saved_secret_resource', id, 'v1'],
                    content: { t: 'plain', v: { v: 1, name: 'Padding', kind: 'token', value: 'fixture' } } }) };
        }) });
        console.info('C31_POSTGRES', JSON.stringify(await db.$queryRaw`SELECT version()`));
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    async function fixture(own = false) {
        const caller = await db.account.create({ data: { encryptionMode: 'plain' } });
        const owner = own ? caller : await db.account.create({ data: { encryptionMode: 'plain' } });
        const unrelatedOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        if (own) await db.userRelationship.create({ data: { fromUserId: caller.id, toUserId: unrelatedOwner.id, status: 'friend' } });
        const ids = { referenced: `a-${randomUUID()}`, unrelated: `z-${randomUUID()}` };
        for (const [resourceId, accountId] of [[ids.referenced, owner.id], [ids.unrelated, unrelatedOwner.id]]) {
            if (accountId !== caller.id) await db.userRelationship.create({ data: { fromUserId: accountId, toUserId: caller.id, status: 'friend' } });
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
                accountId, resourceId, displayName: 'Contract token', kind: 'token', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Contract token', kind: 'token', value: 'fixture' } },
                accountGrants: accountId === caller.id ? [unrelatedOwner.id] : [caller.id],
            }))).toMatchObject({ ok: true });
        }
        const reference = formatSharedSavedSecretRefV1(ids.referenced);
        const payload = ProviderConnectionsRowMutationV1Schema.parse({
            expectedRevision: 'absent', sourceSettingsVersion: 0,
            content: { t: 'plain', v: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [{ v: 1, id: 'pc_contract', source: { kind: 'contribution', contributionKey: 'example/provider' },
                    role: 'default', displayName: 'Contract', displayNameMode: 'automatic', deployment: { kind: 'external' },
                    revision: 0, createdAt: 1, updatedAt: 1 }],
                secretBindingsByConnectionId: { pc_contract: { account: { apiKey: reference }, byMachineId: {} } },
            } }, referencedSavedSecretIds: [reference], savedSecretRevisions: [{ resourceId: ids.referenced, expectedRevision: 1 }],
        });
        return { caller, owner, unrelatedOwner, ids, payload };
    }

    type Fixture = Awaited<ReturnType<typeof fixture>>;
    type Mutation = 'rotation' | 'revocation' | 'deletion' | 'account';
    type PeerStatus = 'not-run' | 'committed' | 'serialized';
    function readPeerStatus(peer: Readonly<{ status: PeerStatus }>): PeerStatus { return peer.status; }

    it('refuses a foreign replacement of an own resource after isolation preflight', async () => {
        const f = await fixture(true);
        const transaction = db.$transaction.bind(db);
        let replaced = false;
        let replacementFailure: unknown;
        db.$transaction = new Proxy(transaction, { async apply(target, receiver, args: unknown[]) {
            if (!replaced) {
                replaced = true;
                await inTx(async other => {
                    expect(await deleteSavedSecretResourceInTx(other, { accountId: f.caller.id, resourceId: f.ids.referenced,
                        expectedRevision: 1, expectedSettingsVersion: 0,
                        referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
                    })).toMatchObject({ ok: true });
                    expect(await createSavedSecretResourceInTx(other, { accountId: f.unrelatedOwner.id, resourceId: f.ids.referenced,
                        displayName: 'Replacement', kind: 'token', encryptionMode: 'plain', accountGrants: [f.caller.id],
                        storedContent: { t: 'plain', v: { v: 1, name: 'Replacement', kind: 'token', value: 'fixture' } },
                    })).toMatchObject({ ok: true });
                }, { isolationLevel: 'Serializable' }).catch(error => { replacementFailure = error; throw error; });
            }
            return Reflect.apply(target, receiver, args);
        } });
        const app = createAuthenticatedTestApp(); registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': f.caller.id }, payload: f.payload });
            if (replacementFailure) throw replacementFailure;
            expect(response.statusCode, response.body).toBe(200);
            expect(ProviderConnectionsRowMutationResponseV1Schema.parse(response.json())).toEqual({ status: 'invalid-reference' });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: {
                accountId: f.caller.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            } } })).toBeNull();
        } finally { db.$transaction = transaction; await app.close(); }
    });

    it('does not commit an own-resource reference alongside canonical deletion after capture', async () => {
        const f = await fixture(true);
        const transaction = db.$transaction;
        let deletion: ReturnType<typeof deleteSavedSecretResourceInTx> | undefined;
        let settled = false;
        let captured = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'savedSecretResource') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.savedSecretResource, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findMany') return operation;
                    return async (...parameters: unknown[]) => {
                        const rows: unknown = await Reflect.apply(operation, delegate, parameters);
                        if (!captured) {
                            captured = true;
                            const [{ pid }] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            deletion = inTx(other => deleteSavedSecretResourceInTx(other, {
                                accountId: f.caller.id, resourceId: f.ids.referenced, expectedRevision: 1, expectedSettingsVersion: 0,
                                referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
                            })).finally(() => { settled = true; });
                            while (!settled) {
                                const [blocked] = await db.$queryRaw<Array<{ count: number }>>`
                                    SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
                                if (blocked.count > 0) break;
                            }
                        }
                        return rows;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        const app = createAuthenticatedTestApp(); registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': f.caller.id }, payload: f.payload });
            expect(captured).toBe(true);
            expect(response.statusCode, response.body).toBe(200);
            const catalog = ProviderConnectionsRowMutationResponseV1Schema.parse(response.json());
            const deleted = await deletion;
            expect(deleted).toBeDefined();
            expect(catalog.status === 'updated' && deleted?.ok === true).toBe(false);
        } finally {
            db.$transaction = transaction;
            if (deletion) await Promise.allSettled([deletion]);
            await app.close();
        }
    });

    it.each(['rotation', 'revocation', 'deletion'] as const)('refuses an own Secret capture after a fenced %s', async mutation => {
        const f = await fixture(true);
        expect(await db.savedSecretAccountGrant.count({ where: { resourceId: f.ids.referenced, accountId: f.unrelatedOwner.id } })).toBe(1);
        const transaction = db.$transaction.bind(db);
        let interleaved = false;
        let observedWait = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                const value = Reflect.get(inner, property, innerReceiver);
                if (property !== '$queryRawUnsafe') return value;
                return async (...queryArgs: unknown[]) => {
                    if (interleaved || typeof queryArgs[0] !== 'string' || !queryArgs[0].includes('"Account"') || !queryArgs[0].includes('FOR UPDATE')) {
                        return Reflect.apply(value, inner, queryArgs);
                    }
                    interleaved = true;
                    let release!: () => void;
                    let locked!: () => void;
                    const held = new Promise<void>(resolve => { locked = resolve; });
                    const released = new Promise<void>(resolve => { release = resolve; });
                    let peerPid = 0;
                    const peer = inTx(async other => {
                        const [backend] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        peerPid = backend.pid;
                        const base = { accountId: f.caller.id, resourceId: f.ids.referenced, expectedRevision: 1 };
                        const result = mutation === 'rotation' ? await updateSavedSecretResourceInTx(other, { ...base,
                            displayName: 'Rotated', kind: 'token', storedContent: { t: 'plain', v: { v: 1, name: 'Rotated', kind: 'token', value: 'changed' } } })
                            : mutation === 'revocation' ? await setSavedSecretResourceGrantsInTx(other, { ...base,
                                accountGrants: [], teamGrants: [], groupGrants: [] })
                                : await deleteSavedSecretResourceInTx(other, { ...base, expectedSettingsVersion: 0,
                                    referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } });
                        expect(result).toMatchObject({ ok: true });
                        locked(); await released;
                    }, { isolationLevel: 'Serializable' });
                    // A failed peer must not strand the admission wait.
                    void peer.catch(() => { locked(); });
                    await held;
                    let settled = false;
                    const fence = Promise.resolve(Reflect.apply(value, inner, queryArgs))
                        .then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
                    try {
                        while (!settled) {
                            const [blocked] = await db.$queryRaw<Array<{ count: number }>>`
                                SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${peerPid} = ANY(pg_blocking_pids(pid))`;
                            if (blocked.count > 0) { observedWait = true; break; }
                            await new Promise(resolve => setTimeout(resolve, 1));
                        }
                    } finally { release(); await peer; }
                    const outcome = await fence;
                    if ('error' in outcome) throw outcome.error;
                    return outcome.result;
                };
            } })), ...args.slice(1)]);
        } });
        const app = createAuthenticatedTestApp(); registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': f.caller.id }, payload: f.payload });
            expect(observedWait).toBe(true);
            expect(response.statusCode, response.body).toBe(200);
            expect(ProviderConnectionsRowMutationResponseV1Schema.parse(response.json())).toEqual({ status: 'invalid-reference' });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: {
                accountId: f.caller.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            } } })).toBeNull();
            const resource = await db.savedSecretResource.findUnique({ where: { id: f.ids.referenced }, select: { revision: true } });
            if (mutation === 'deletion') expect(resource).toBeNull();
            else expect(resource).toEqual({ revision: 2 });
            if (mutation === 'revocation') expect(await db.savedSecretAccountGrant.count({ where: { resourceId: f.ids.referenced } })).toBe(0);
        } finally { db.$transaction = transaction; await app.close(); }
    });

    /** Raw peer writes isolate the SSI read dependency from Account-publication locks.
     * Both transactions use real PostgreSQL; route, validation, CAS and publication stay real.
     */
    async function interleave(f: Fixture, mutation: Mutation, referenced: boolean, fullCatalogRead = false) {
        const transaction = db.$transaction.bind(db);
        const peer: { status: 'not-run' | 'committed' | 'serialized' } = { status: 'not-run' };
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                // Tiny disposable tables otherwise take relation-wide predicate locks.
                // Select index paths to distinguish logical read sets, not planner false positives.
                await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
                await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
                const result = await callback(tx);
                if (fullCatalogRead) await listSavedSecretResourcesForAccountInTx(tx, f.caller.id);
                if (mutation === 'rotation' && !referenced) console.info('C31_PREDICATES', JSON.stringify({ fullCatalogRead,
                    locks: await tx.$queryRaw`SELECT relation::regclass::text AS relation, page, tuple
                        FROM pg_locks WHERE pid = pg_backend_pid() AND mode = 'SIReadLock'`,
                }));
                try {
                    await transaction(async other => {
                        await other.$executeRaw`SET LOCAL enable_seqscan = off`;
                        await other.$executeRaw`SET LOCAL enable_bitmapscan = off`;
                        // Read the catalog being published: together with the resource
                        // read this creates a cycle only if the writer read our target.
                        await other.userKVStore.findUnique({ where: { accountId_key: {
                            accountId: f.caller.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
                        } } });
                        const resourceId = referenced ? f.ids.referenced : f.ids.unrelated;
                        if (mutation === 'rotation') await other.savedSecretResource.update({ where: { id: resourceId }, data: { revision: { increment: 1 } } });
                        else if (mutation === 'revocation') await other.savedSecretAccountGrant.deleteMany({ where: { resourceId, accountId: f.caller.id } });
                        else if (mutation === 'deletion') await other.savedSecretResource.delete({ where: { id: resourceId } });
                        else await other.account.update({ where: { id: f.unrelatedOwner.id }, data: { name: 'Changed unrelated owner' } });
                    }, { isolationLevel: 'Serializable' });
                    peer.status = 'committed';
                } catch (error) {
                    if (!isPrismaErrorCode(error, 'P2034')) throw error;
                    peer.status = 'serialized';
                }
                return result;
            }, ...args.slice(1)]);
        } });
        const app = createAuthenticatedTestApp();
        registerProviderConnectionsRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                headers: { 'x-test-user-id': f.caller.id }, payload: f.payload });
            console.info('C31_INTERLEAVE', JSON.stringify({ mutation, referenced, fullCatalogRead, peer: peer.status, status: response.statusCode }));
            return { peer: readPeerStatus(peer), response };
        } finally {
            db.$transaction = transaction;
            await app.close();
        }
    }

    it.each(['rotation', 'revocation', 'account'] as const)('commits the Provider catalog alongside unrelated %s', async mutation => {
        const f = await fixture();
        const { peer, response } = await interleave(f, mutation, false);
        expect(peer).toBe('committed');
        expect(response.statusCode, response.body).toBe(200);
        expect(ProviderConnectionsRowMutationResponseV1Schema.parse(response.json())).toMatchObject({ status: 'updated', revision: 0 });
        expect(await inTx(tx => listSavedSecretResourcesForAccountInTx(tx, f.caller.id)))
            .toEqual(expect.arrayContaining([expect.objectContaining({ ref: formatSharedSavedSecretRefV1(f.ids.referenced), revision: 1 })]));
    });

    it.each(['rotation', 'revocation', 'account'] as const)('discriminates the full catalog read with unrelated %s', async mutation => {
        const { peer, response } = await interleave(await fixture(), mutation, false, true);
        expect(peer === 'serialized' || response.statusCode === 503).toBe(true);
        if (peer === 'committed') expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
    });

    it.each(['rotation', 'revocation', 'deletion'] as const)('serializes concurrent referenced Secret %s', async mutation => {
        const f = await fixture();
        const { peer, response } = await interleave(f, mutation, true);
        expect(peer === 'serialized' || response.statusCode === 503).toBe(true);
        if (peer === 'committed') {
            expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
            expect(await db.userKVStore.findUnique({ where: { accountId_key: {
                accountId: f.caller.id, key: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
            } } })).toBeNull();
            const app = createAuthenticatedTestApp();
            registerProviderConnectionsRoutes(app);
            try {
                const retry = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
                    headers: { 'x-test-user-id': f.caller.id }, payload: f.payload });
                expect(retry.statusCode, retry.body).toBe(200);
                expect(ProviderConnectionsRowMutationResponseV1Schema.parse(retry.json())).toEqual({ status: 'invalid-reference' });
            } finally { await app.close(); }
        }
    });

    type Sibling = 'profile' | 'transfer' | 'history';

    async function siblingFixture(sibling: Sibling) {
        const f = await fixture();
        const historyContent = { t: 'plain' as const, v: { secrets: [SavedSecretSchema.parse({ id: 'personal-source', name: 'Source', kind: 'token',
            encryptedValue: { _isSecretValue: true, value: 'fixture' }, createdAt: 1, updatedAt: 1 })], preferredLanguage: 'de' } };
        if (sibling === 'history') {
            f.ids.referenced = deriveSavedSecretImportResourceIdV1({ accountId: f.caller.id,
                source: { kind: 'personal-saved-secret', secretId: 'personal-source' } });
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: f.caller.id, resourceId: f.ids.referenced,
                displayName: 'Imported', kind: 'token', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Imported', kind: 'token', value: 'fixture' } } })))
                .toMatchObject({ ok: true });
            await db.accountSettingsSnapshot.create({ data: { accountId: f.caller.id, version: 1, encryptionMode: 'plain',
                contentKind: 'plain', settingsDbValue: storePlainAccountSettingsDbValue({ accountId: f.caller.id, content: historyContent }) } });
        }
        const reference = formatSharedSavedSecretRefV1(f.ids.referenced);
        const record = { v: 1, id: 'sibling-profile', enabled: true, promptStack: [], skillSeeds: [], secretBindings: { TOKEN: reference },
            definition: { kind: 'inline', profile: { v: 2, id: 'sibling-profile', name: 'Sibling', extraEnvironmentVariables: [],
                defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } } };
        const profileMutation = ProfileRowMutationV1Schema.parse({ operation: 'create', id: record.id, expectedRevision: 'absent',
            content: { t: 'plain', v: record }, referencedSavedSecretIds: [reference],
            savedSecretRevisions: [{ resourceId: f.ids.referenced, expectedRevision: 1 }] });
        const inventory = [{ kind: 'account_row', id: record.id, revision: 0 }, { kind: 'saved_secret', id: f.ids.referenced, revision: 1 }];
        const transferMutation = ProfileTransferMutationV1Schema.parse({ operation: 'prepare', expectedRevision: 'absent',
            sourceSettingsVersion: 0, imports: [], inventory,
            content: { t: 'plain', v: { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory } } });
        if (sibling === 'transfer') {
            await db.account.update({ where: { id: f.caller.id }, data: {
                settings: storePlainAccountSettingsDbValue({ accountId: f.caller.id, content: { t: 'plain', v: { profiles: [] } } }),
            } });
            await db.userKVStore.create({ data: { accountId: f.caller.id, key: buildProfilePhysicalKey(record.id), version: 0,
                value: new TextEncoder().encode(JSON.stringify(profileMutation.content)) } });
        }
        const historyMutation = AccountSettingsV2HistoryMutationRequestSchema.parse({ expectedSettingsVersion: 0,
            expectedProfileTransferRevision: 'absent', expectedEncryptionCurrentness: {
                mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null }, expectedContent: historyContent,
            operation: { kind: 'normalize', removedRoots: [], savedSecretTransfers: [{ savedSecretId: 'personal-source',
                resourceId: f.ids.referenced, expectedRevision: 1 }], content: { t: 'plain', v: { secrets: [], preferredLanguage: 'de' } } } });
        const key = sibling === 'profile' ? buildProfilePhysicalKey(record.id) : PROFILE_TRANSFER_ACCOUNT_KV_KEY;
        const readPublication = async (tx: Tx) => sibling === 'history'
            ? tx.accountSettingsSnapshot.findUnique({ where: { accountId_version: { accountId: f.caller.id, version: 1 } } })
            : tx.userKVStore.findUnique({ where: { accountId_key: { accountId: f.caller.id, key } } });
        const run = async (tx: Tx) => sibling === 'profile'
            ? mutateProfileRowsInTx(tx, { accountId: f.caller.id, mutations: [profileMutation] })
            : sibling === 'transfer' ? mutateProfileTransferInTx(tx, { accountId: f.caller.id, mutation: transferMutation })
                : mutateAccountSettingsHistorySnapshotInTx({ tx, accountId: f.caller.id, version: 1, mutation: historyMutation });
        return { ...f, run, readPublication };
    }

    type SiblingFixture = Awaited<ReturnType<typeof siblingFixture>>;

    async function interleaveSibling(f: SiblingFixture, mutation: Exclude<Mutation, 'account'>, referenced: boolean, fullCatalogRead = false) {
        const peer: { status: 'not-run' | 'committed' | 'serialized' } = { status: 'not-run' };
        try {
            const result = await inTx(async tx => {
                await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
                await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
                const result = await f.run(tx);
                expect(['updated', 'applied']).toContain(result.status);
                if (fullCatalogRead) await listSavedSecretResourcesForAccountInTx(tx, f.caller.id);
                try {
                    // This real peer establishes the same SSI cycle as the Provider
                    // route test, without invoking the separate Account-publication lock.
                    await db.$transaction(async other => {
                        await other.$executeRaw`SET LOCAL enable_seqscan = off`;
                        await other.$executeRaw`SET LOCAL enable_bitmapscan = off`;
                        await f.readPublication(other);
                        const resourceId = referenced ? f.ids.referenced : f.ids.unrelated;
                        if (mutation === 'rotation') await other.savedSecretResource.update({ where: { id: resourceId }, data: { revision: { increment: 1 } } });
                        else if (mutation === 'revocation') await other.savedSecretAccountGrant.deleteMany({ where: { resourceId, accountId: f.caller.id } });
                        else await other.savedSecretResource.delete({ where: { id: resourceId } });
                    }, { isolationLevel: 'Serializable' });
                    peer.status = 'committed';
                } catch (error) {
                    if (!isPrismaErrorCode(error, 'P2034')) throw error;
                    peer.status = 'serialized';
                }
                return result;
            }, { isolationLevel: 'Serializable' });
            return { peer: readPeerStatus(peer), result };
        } catch (error) {
            if (!isPrismaErrorCode(error, 'P2034') && !isTransactionConflictExhaustedError(error)) throw error;
            return { peer: readPeerStatus(peer), result: { status: 'serialized' } };
        }
    }

    describe.each(['profile', 'transfer', 'history'] as const)('%s Secret reference siblings', sibling => {
        it.each(['rotation', 'revocation'] as const)('commits alongside unrelated %s', async mutation => {
            const f = await siblingFixture(sibling);
            const { peer, result } = await interleaveSibling(f, mutation, false);
            expect(peer).toBe('committed');
            expect(result.status).toBe(sibling === 'history' ? 'applied' : 'updated');
        });

        it.each(['rotation', 'revocation'] as const)('discriminates a full-catalog read alongside unrelated %s', async mutation => {
            const outcome = await interleaveSibling(await siblingFixture(sibling), mutation, false, true);
            expect(outcome.peer === 'serialized' || outcome.result.status === 'serialized').toBe(true);
        });

        it.each(sibling === 'history' ? ['rotation', 'deletion'] as const : ['rotation', 'revocation', 'deletion'] as const)(
            'rolls back or refuses referenced %s', async mutation => {
                const f = await siblingFixture(sibling);
                const before = await inTx(tx => f.readPublication(tx));
                const outcome = await interleaveSibling(f, mutation, true);
                expect(outcome.peer === 'serialized' || outcome.result.status === 'serialized').toBe(true);
                if (outcome.peer === 'committed') {
                    expect(await inTx(tx => f.readPublication(tx))).toEqual(before);
                    const retry = await inTx(tx => f.run(tx), { isolationLevel: 'Serializable' });
                    expect(retry.status).toBe(sibling === 'history' ? 'conflict'
                        : sibling === 'transfer' && mutation === 'rotation' ? 'inventory-incomplete' : 'invalid-reference');
                    expect(await inTx(tx => f.readPublication(tx))).toEqual(before);
                }
            },
        );
    });
});
