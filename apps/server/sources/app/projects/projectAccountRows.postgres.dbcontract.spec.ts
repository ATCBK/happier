import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { type Tx } from '@/storage/inTx';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { decodeBase64 } from 'privacy-kit';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { mutateProjectAccountRows } from './projectAccountRowService';

type OrganizationKey = Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>;

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Project row late CAS conflicts', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['existing', 'absent'] as const)('maps a real %s-row CAS loss after rollback of the earlier Project row', async state => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const first: OrganizationKey = { kind: 'project-organization', serverId: 'home', projectKey: 'a-first' };
        const second: OrganizationKey = { kind: 'project-organization', serverId: 'home', projectKey: 'z-conflict' };
        const secondPhysicalKey = buildProjectAccountRowPhysicalKeyV1(second);
        const content = (key: OrganizationKey, label: string) => ({ t: 'plain' as const, v: { key, value: { label } } });
        const storedContent = (key: OrganizationKey, label: string) => decodeBase64(encodeAccountScopedKvJson(content(key, label))!);
        if (state === 'existing') await db.userKVStore.create({ data: { accountId: account.id, key: secondPhysicalKey,
            version: 0, value: storedContent(second, 'original') } });
        const transaction = db.$transaction;
        let interleaved = false;
        // Only the database boundary is intercepted: the peer commits a real
        // competing row after admission and before the real SQL CAS executes.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'userKVStore') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== (state === 'existing' ? 'updateMany' : 'create')) return operation;
                    return async (...parameters: unknown[]) => {
                        const argument = parameters[0] as { data?: { key?: string }; where?: { key?: string } };
                        if (!interleaved && (argument.where?.key ?? argument.data?.key) === secondPhysicalKey) {
                            interleaved = true;
                            if (state === 'existing') await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: secondPhysicalKey } },
                                data: { version: 1, value: storedContent(second, 'peer') } });
                            else await db.userKVStore.create({ data: { accountId: account.id, key: secondPhysicalKey,
                                version: 0, value: storedContent(second, 'peer') } });
                        }
                        return Reflect.apply(operation, delegate, parameters);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await mutateProjectAccountRows({ accountId: account.id, request: { topologyChange: false, expectedRefs: [], mutations: [
                { key: first, expectedRevision: 'absent', content: content(first, 'must roll back') },
                { key: second, expectedRevision: state === 'existing' ? 0 : 'absent', content: content(second, 'loser') },
            ] } })).toEqual({ status: 'conflict', key: second, revision: state === 'existing' ? 1 : 0 });
            expect(interleaved).toBe(true);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(first) } } })).toBeNull();
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: secondPhysicalKey } } })).value)
                .toEqual(storedContent(second, 'peer'));
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(0);
        } finally { db.$transaction = transaction; }
    });
});
