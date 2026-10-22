import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { TEAM_CHANGE_ENTITY_ID } from '@/app/teams/teamChanges';
import { mutateQualifiedConnectedServiceCredential } from './credentialRepository';
import {
    createQualifiedConnectedAccountGroup, patchQualifiedConnectedAccountGroup,
    patchQualifiedConnectedAccountGroupRuntimeState, createQualifiedConnectedAccountGroupMember,
    updateQualifiedConnectedAccountGroupMember, deleteQualifiedConnectedAccountGroupMember,
    setQualifiedConnectedAccountGroupActiveAccount, deleteQualifiedConnectedAccountGroup,
} from './groupRepository';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Pool source publication admission (PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect(); connected = true;
        process.env.HANDY_MASTER_SECRET ??= 'pool-admission-disposable-contract';
        await initEncrypt();
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it.each(['pool', 'member'] as const)('deletes a %s during Account publication without losing the committed result', async kind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const service = { pluginId: 'example.pool-deletion', localId: 'service' };
        const ref = { service, accountId: randomUUID() };
        const groupRef = { service, groupId: randomUUID() };
        const peerScope = new AsyncLocalStorage<boolean>();
        const original = db.$transaction;
        const peers: Promise<unknown>[] = [];
        let publications = 0;
        try {
            expect(await mutateQualifiedConnectedServiceCredential({ accountId: owner.id, ref,
                expectedCredentialRevision: null, authenticationModeId: 'api-key',
                content: { t: 'plain', v: { token: 'disposable-fixture' } }, metadata: { scopes: [] },
            })).toMatchObject({ status: 'written' });
            const created = await createQualifiedConnectedAccountGroup({ accountId: owner.id, service, group: { groupId: groupRef.groupId } });
            if (created.status !== 'written') throw new Error('Pool fixture creation failed');
            const joined = await createQualifiedConnectedAccountGroupMember({ accountId: owner.id, mutation: {
                group: groupRef, connectedAccountId: ref.accountId, expectedGeneration: created.group.generation, priority: 0,
            } });
            if (joined.status !== 'written') throw new Error('Pool fixture membership failed');
            db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function' || peerScope.getStore()) return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const query = tx.$queryRawUnsafe.bind(tx);
                    let scheduled = false;
                    const observed = new Proxy(tx, { get(transaction, property, receiver) {
                        if (property !== '$queryRawUnsafe') return Reflect.get(transaction, property, receiver);
                        return async (...values: Parameters<typeof query>) => {
                            if (!scheduled && values[0].includes('FROM "Account"') && values[0].endsWith('FOR NO KEY UPDATE')) {
                                scheduled = true;
                                let settled = false;
                                const peer = peerScope.run(true, () => inTx(async writer => {
                                    await markAccountChanged(writer, { accountId: owner.id, kind: 'account', entityId: 'pool-delete-peer' });
                                })).finally(() => { settled = true; });
                                peers.push(peer);
                                void peer.catch(() => undefined);
                                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                while (!settled) {
                                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                                    `;
                                    if (blocked) break;
                                }
                                publications++;
                            }
                            return query(...values);
                        };
                    } });
                    return callback(observed);
                }, ...args.slice(1)]);
            } });
            const expected = { accountId: owner.id, expectedIncarnation: joined.group.incarnation };
            const result = kind === 'pool'
                ? await deleteQualifiedConnectedAccountGroup({ ...expected, ...groupRef,
                    expectedGeneration: joined.group.generation, expectedRuntimeStateRevision: joined.group.runtimeStateRevision })
                : await deleteQualifiedConnectedAccountGroupMember({ ...expected, mutation: { group: groupRef,
                    connectedAccountId: ref.accountId, expectedGeneration: joined.group.generation,
                    expectedRuntimeStateRevision: joined.group.runtimeStateRevision } });
            expect(result).toMatchObject({ status: kind === 'pool' ? 'deleted' : 'written' });
            expect(publications).toBeGreaterThan(0);
            expect(await db.connectedServiceAuthGroupMember.count({ where: { accountId: owner.id } })).toBe(0);
            expect(await db.connectedServiceAuthGroup.count({ where: { accountId: owner.id } })).toBe(kind === 'pool' ? 0 : 1);
        } finally {
            db.$transaction = original;
            const outcomes = await Promise.allSettled(peers);
            await db.account.delete({ where: { id: owner.id } });
            expect(outcomes.filter(result => result.status === 'rejected')).toEqual([]);
        }
    });

    it('commits after a concurrent Team audience change and publishes every sibling Pool mutation', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const joiningRecipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const service = { pluginId: 'example.pool-admission', localId: 'service' };
        const ref = { service, accountId: randomUUID() };
        expect(await mutateQualifiedConnectedServiceCredential({ accountId: owner.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'disposable-fixture' } }, metadata: { scopes: [] },
        })).toMatchObject({ status: 'written' });
        const team = await db.team.create({ data: { name: 'Pool publication recipients' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: recipient.id, role: 'member' },
        ] });
        // Existing source authority means all Pool writes invalidate this Team's
        // projection, including creation of a different Pool by this custodian.
        await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: owner.id, displayName: 'Shared source',
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection', connectionId: 'pool-fixture',
                connectionSecurityFingerprint: 'pool-fixture', credentialSlotId: 'apiKey' }),
        } });
        const groupRef = { service, groupId: randomUUID() };
        const locked = deferred(), release = deferred();
        let holderPid = 0;
        let createFinished = false;
        const holderOutcome = Promise.allSettled([db.$transaction(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            holderPid = backend.pid;
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', owner.id);
            locked.resolve();
            await release.promise;
            await tx.teamMembership.create({ data: { teamId: team.id, accountId: joiningRecipient.id, role: 'member' } });
        }, { isolationLevel: 'ReadCommitted' })]);
        let createOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof createQualifiedConnectedAccountGroup>>>[]> | undefined;
        try {
            await Promise.race([locked.promise, holderOutcome.then(() => { throw new Error('Audience writer ended before taking its fence'); })]);
            createOutcome = Promise.allSettled([createQualifiedConnectedAccountGroup({ accountId: owner.id, service,
                group: { groupId: groupRef.groupId },
            }).finally(() => { createFinished = true; })]);
            let blocked: Array<{ query: string }> = [];
            while (!createFinished && blocked.length === 0) {
                blocked = await db.$queryRawUnsafe<Array<{ query: string }>>(
                    'SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', holderPid,
                );
            }
            expect(blocked, 'Pool create must wait for Account authority before its mutation').toHaveLength(1);
            expect(blocked[0].query).toMatch(/Account.*FOR (KEY SHARE|UPDATE|NO KEY UPDATE)/s);
            release.resolve();
            const [peer] = await holderOutcome;
            if (peer.status === 'rejected') throw peer.reason;
            const [created] = await createOutcome;
            if (created.status === 'rejected') throw created.reason;
            expect(created.value).toMatchObject({ status: 'written' });
            if (created.value.status !== 'written') throw new Error('Expected committed Pool');
            let group = created.value.group;
            expect(await db.connectedServiceAuthGroup.findUnique({ where: { id: group.incarnation } })).toMatchObject({
                accountId: owner.id, groupId: groupRef.groupId,
            });
            const assertPublished = async () => {
                for (const accountId of [recipient.id, joiningRecipient.id]) {
                    expect(await db.accountChange.count({ where: { accountId, kind: 'account', entityId: TEAM_CHANGE_ENTITY_ID } })).toBe(1);
                }
                await db.accountChange.deleteMany({ where: { accountId: { in: [recipient.id, joiningRecipient.id] } } });
            };
            await assertPublished();
            const mutations = [
                () => patchQualifiedConnectedAccountGroup({ accountId: owner.id, expectedIncarnation: group.incarnation,
                    patch: { ...groupRef, expectedGeneration: group.generation, displayName: 'Changed' } }),
                () => createQualifiedConnectedAccountGroupMember({ accountId: owner.id, mutation: {
                    group: groupRef, connectedAccountId: ref.accountId, expectedGeneration: group.generation, priority: 1,
                } }),
                () => updateQualifiedConnectedAccountGroupMember({ accountId: owner.id, mutation: {
                    group: groupRef, connectedAccountId: ref.accountId, expectedGeneration: group.generation, priority: 2,
                } }),
                () => setQualifiedConnectedAccountGroupActiveAccount({ accountId: owner.id, mutation: {
                    group: groupRef, connectedAccountId: ref.accountId, expectedGeneration: group.generation,
                } }),
                () => patchQualifiedConnectedAccountGroupRuntimeState({ accountId: owner.id, patch: {
                    ...groupRef, expectedGeneration: group.generation, expectedRuntimeStateRevision: group.runtimeStateRevision,
                    runtimeState: { memberStates: [{ connectedAccountId: ref.accountId, state: { cooldownUntilMs: Date.now() + 1000 } }] },
                } }),
                () => deleteQualifiedConnectedAccountGroupMember({ accountId: owner.id, mutation: {
                    group: groupRef, connectedAccountId: ref.accountId, expectedGeneration: group.generation,
                } }),
            ];
            for (const mutate of mutations) {
                const result = await mutate();
                expect(result).toMatchObject({ status: 'written' });
                if (result.status !== 'written') throw new Error('Expected committed Pool mutation');
                group = result.group;
                await assertPublished();
            }
            expect(await deleteQualifiedConnectedAccountGroup({ accountId: owner.id, ...groupRef,
                expectedIncarnation: group.incarnation, expectedGeneration: group.generation,
            })).toMatchObject({ status: 'deleted' });
            await assertPublished();
            expect(await db.connectedServiceAuthGroup.count({ where: { accountId: owner.id, groupId: groupRef.groupId } })).toBe(0);
        } finally {
            release.resolve();
            await holderOutcome; await createOutcome;
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id, joiningRecipient.id] } } });
        }
    });
});
