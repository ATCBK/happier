import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createSavedSecretResourceInTx, promoteSavedSecretResourceInTx, setSavedSecretResourceGrantsInTx } from './savedSecretResourceService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('SavedSecret complete early publication admission', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST = 'none';
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST = 'none';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['create', 'grants', 'promotion'] as const)('admits every %s recipient together before Account or resource locking', async operation => {
        const owner = await db.account.create({ data: { id: `z-owner-${randomUUID()}`, encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { id: `a-viewer-${randomUUID()}`, encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
        const resourceId = randomUUID();
        const resource = { accountId: owner.id, resourceId, displayName: 'Shared token', kind: 'token' as const,
            encryptionMode: 'plain' as const, storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Shared token', kind: 'token' as const, value: 'private' } },
            accountGrants: [recipient.id] };
        if (operation === 'grants') expect(await inTx(tx => createSavedSecretResourceInTx(tx, { ...resource, accountGrants: [] }))).toMatchObject({ ok: true });
        const transaction = db.$transaction;
        let wroteResource = false;
        let firstAccountAdmission: readonly string[] | undefined;
        // Observe real DB admission and resource writes. The application,
        // eligibility checks, grants, row CAS and terminal publication stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === 'savedSecretResource') return new Proxy(inner.savedSecretResource, { get(delegate, method, delegateReceiver) {
                    const write = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'create' && method !== 'updateMany' && method !== 'deleteMany') return write;
                    return (...input: unknown[]) => { wroteResource = true; return Reflect.apply(write, delegate, input); };
                } });
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (firstAccountAdmission === undefined && query.includes('FROM "Account"') && query.includes('FOR ')) {
                        firstAccountAdmission = values.flatMap(value => Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === 'string');
                        expect(wroteResource, 'resource write must follow complete Account admission').toBe(false);
                        expect([...firstAccountAdmission].sort()).toEqual([owner.id, recipient.id].sort());
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await inTx(async tx => operation === 'create' ? await createSavedSecretResourceInTx(tx, resource)
                : operation === 'grants' ? await setSavedSecretResourceGrantsInTx(tx, { accountId: owner.id, resourceId,
                    expectedRevision: 1, accountGrants: [recipient.id], teamGrants: [], groupGrants: [] })
                : await promoteSavedSecretResourceInTx(tx, { ...resource, profileMutations: [], expectedSettingsVersion: 0, nextSettings: null,
                    referenceCensus: { accountMode: 'plain', profileTransferRevision: 'absent',
                        profiles: { referenceGuardRevision: 'absent', rows: [] }, artifacts: [],
                        catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent', connectedPurposes: 'absent' },
                        remoteHosts: { revision: 'absent', resourceRefs: [] }, notificationChannels: { revision: 'absent', resourceRefs: [] } },
                    notificationChannelMutation: { expectedRevision: 'absent', sourceSettingsVersion: 0,
                        content: { t: 'plain', v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {}, id: 'hook', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: formatSharedSavedSecretRefV1(resourceId) }] }) },
                        savedSecretRevisions: [{ resourceRef: formatSharedSavedSecretRefV1(resourceId), revision: 1 }] },
                }));
            expect(result).toMatchObject({ ok: true });
            expect(firstAccountAdmission).toBeDefined();
            expect(wroteResource).toBe(true);
            const publications = await db.accountChange.findMany({ where: { entityId: resourceId }, select: { accountId: true } });
            expect(publications.map(row => row.accountId).sort()).toEqual([owner.id, recipient.id].sort());
        } finally { db.$transaction = transaction; }
    });
});
