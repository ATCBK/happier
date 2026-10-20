import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { buildConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { mutateConnectedAccountCatalogRow } from './configurationRows';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Connected Account catalog source currentness at publication', () => {
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

    it('refuses initialization if captured Settings change before terminal publication', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const transaction = db.$transaction;
        let advancedSettings = false;
        // Interleave a genuine committed Settings writer at the database lock
        // boundary, after catalog admission and before terminal Account locking.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (!advancedSettings && query.includes('FROM "Account"') && query.includes('FOR NO KEY UPDATE')) {
                        advancedSettings = true;
                        expect(await inTx(peer => writeAccountSettingsInTx({ tx: peer, accountId: account.id, expectedVersion: 0,
                            next: { kind: 'v2', content: { t: 'plain', v: { connectedAccountPurposeBindingsV1: { v: 1, bindings: [] } } } },
                        }))).toEqual({ status: 'success', version: 1 });
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await mutateConnectedAccountCatalogRow({ accountId: account.id, key: 'purposes',
                expectedRevision: 'absent', sourceSettingsVersion: 0, referencedSavedSecretIds: [],
                content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
            })).toEqual({ status: 'settings-conflict', revision: 1 });
            expect(advancedSettings).toBe(true);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id,
                key: buildConnectedAccountCatalogPhysicalKeyV1('purposes') } } })).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(1);
        } finally { db.$transaction = transaction; }
    });
});
