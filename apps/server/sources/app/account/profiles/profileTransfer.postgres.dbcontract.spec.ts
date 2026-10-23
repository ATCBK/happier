import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProfileTransferMutationV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { PROFILE_TRANSFER_ACCOUNT_KV_KEY } from '@/app/kv/accountScopedKv';
import { storePlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { mutateProfileRowsInTx } from './profileRows';
import { mutateProfileTransfer } from './profileTransferRows';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Profile transfer Account-local admission', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST = 'none';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    async function fixture(operation: 'prepare' | 'activate') {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const control = { v: 1, phase: 'prepared', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] };
        if (operation === 'activate') await db.userKVStore.create({ data: { accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY,
            version: 0, value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: control })) } });
        else await db.account.update({ where: { id: account.id }, data: { settings: storePlainAccountSettingsDbValue({
            accountId: account.id, content: { t: 'plain', v: { profiles: [] } },
        }) } });
        const mutation = ProfileTransferMutationV1Schema.parse(operation === 'activate'
            ? { operation, sourceSettingsVersion: 0, expectedRevision: 0, inventory: [], content: { t: 'plain', v: { ...control, phase: 'active' } } }
            : { operation, sourceSettingsVersion: 0, expectedRevision: 'absent', imports: [], inventory: [], content: { t: 'plain', v: control } });
        return { account, mutation };
    }

    describe.each(['prepare', 'activate'] as const)('%s', phase => {
        it.each(['cursor', 'settings'] as const)('admits fresh %s currentness after a concurrent Account commit', async change => {
            const { account, mutation } = await fixture(phase);
            const transaction = db.$transaction;
            let advances = 0;
            // Only the real database boundary is scheduled: every attempt captures
            // Account state, then a genuine concurrent commit advances the hot row.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                    advances += 1;
                    await db.account.update({ where: { id: account.id }, data: change === 'cursor'
                        ? { seq: { increment: 1 } } : { settingsVersion: { increment: 1 } } });
                    return callback(tx);
                }, ...args.slice(1)]);
            } });
            try {
                if (change === 'cursor') {
                    expect(await mutateProfileTransfer({ accountId: account.id, mutation })).toMatchObject({ status: 'updated', revision: phase === 'activate' ? 1 : 0 });
                    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(2);
                } else {
                    expect(await mutateProfileTransfer({ accountId: account.id, mutation })).toEqual({ status: 'settings-conflict', revision: 1 });
                    const control = await db.userKVStore.findUnique({ where: { accountId_key: {
                        accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY } } });
                    if (phase === 'activate') expect(control?.version).toBe(0);
                    else expect(control).toBeNull();
                    expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
                }
                expect(advances).toBe(1);
            } finally {
                db.$transaction = transaction;
                await db.account.delete({ where: { id: account.id } });
            }
        });

        it('holds the complete Profile census against a real concurrent Profile insert until commit', async () => {
            const { account, mutation } = await fixture(phase);
            const transaction = db.$transaction;
            let peer: Promise<unknown> | undefined;
            let peerSettled = false;
            let observedBlockedWriter = false;
            const profileId = randomUUID();
            const record = ProfileRecordV1Schema.parse({ v: 1, id: profileId, enabled: true,
                promptStack: [], skillSeeds: [], secretBindings: {}, definition: { kind: 'inline', profile: {
                    v: 2, id: profileId, name: 'Concurrent Profile', extraEnvironmentVariables: [],
                    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
                } } });
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'userKVStore') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findMany') return operation;
                        return async (...parameters: unknown[]) => {
                            const rows: unknown = await Reflect.apply(operation, delegate, parameters);
                            if (!peer) {
                                const [{ pid }] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                // The peer uses the canonical Profile writer and its content admission.
                                peer = inTx(peerTx => mutateProfileRowsInTx(peerTx, { accountId: account.id, mutations: [{
                                    operation: phase === 'prepare' ? 'import' : 'create', id: record.id, expectedRevision: 'absent',
                                    content: { t: 'plain', v: record }, referencedSavedSecretIds: [],
                                }] })).finally(() => { peerSettled = true; });
                                while (!peerSettled) {
                                    const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                                        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                                        AND ${pid} = ANY(pg_blocking_pids(pid))
                                    `;
                                    if (blocked.length > 0) { observedBlockedWriter = true; break; }
                                }
                                expect(observedBlockedWriter, 'Profile insertion must wait behind the census admission').toBe(true);
                            }
                            return rows;
                        };
                    } });
                } })), ...args.slice(1)]);
            } });
            try {
                expect(await mutateProfileTransfer({ accountId: account.id, mutation })).toMatchObject({ status: 'updated' });
                expect(await peer).toMatchObject({ status: 'updated' });
                expect(observedBlockedWriter).toBe(true);
                expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
                    accountId: account.id, key: PROFILE_TRANSFER_ACCOUNT_KV_KEY } } })).version).toBe(phase === 'activate' ? 1 : 0);
            } finally {
                db.$transaction = transaction;
                if (peer) await Promise.allSettled([peer]);
                await db.account.delete({ where: { id: account.id } });
            }
        });
    });
});
