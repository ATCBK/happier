import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { applyMachineReplacement } from '@/app/machines/applyMachineReplacement';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createSignedDiscussionHttpFixture, createSignedDiscussionModelBirthFixture } from './discussionExecutionAuthorization.testkit';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('signed model Session HTTP birth (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        for (const [key, value] of Object.entries({ HANDY_MASTER_SECRET: 'serialaudit-signed-model-fixture-only',
            AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
        })) vi.stubEnv(key, value);
        initDbPostgres();
        await db.$connect();
        await auth.init();
        await initEncrypt();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it.each(['hot-cursor', 'source-replaced', 'target-replaced', 'source-grant-withdrawn', 'target-grant-withdrawn',
        'foreign-target-replaced-pending'] as const)(
        'rechecks the signed native proof with %s at Session insertion', async operation => {
            const custodian = operation.includes('grant') || operation.startsWith('foreign')
                ? await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } }) : undefined;
            const f = await createSignedDiscussionHttpFixture(undefined, [], false, custodian?.id);
            const birth = await createSignedDiscussionModelBirthFixture(f);
            const changedMachine = operation.startsWith('source') ? f.machine : birth.target;
            const replacement = operation.includes('replaced') ? await db.machine.create({ data: {
                ...changedMachine, id: randomUUID(), installationId: randomUUID(),
            } }) : undefined;
            const transaction = db.$transaction;
            let peer: Promise<unknown> | undefined;
            let peerInFlight = false;
            let advances = 0;
            const held = deferred(), release = deferred();
            const pendingReplacement = operation.endsWith('pending');
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                if (peerInFlight) {
                    if (!pendingReplacement) return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                        if (property !== '$queryRawUnsafe') return Reflect.get(client, property, clientReceiver);
                        return async (query: string, ...values: unknown[]) => {
                            const result = await client.$queryRawUnsafe(query, ...values);
                            // Pause only after the canonical replacement publisher owns
                            // its real terminal custodian Account lock. It has not committed.
                            if (query.includes('FROM "Account"') && query.includes('FOR NO KEY UPDATE')) {
                                held.resolve();
                                await release.promise;
                            }
                            return result;
                        };
                    } })), ...args.slice(1)]);
                }
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(client, property, clientReceiver) {
                    const delegate = Reflect.get(client, property, clientReceiver);
                    if (property !== 'session') return delegate;
                    return new Proxy(delegate, { get(model, method, modelReceiver) {
                        const query = Reflect.get(model, method, modelReceiver);
                        if (method !== 'create') return query;
                        return async (...values: unknown[]) => {
                            if (!peer || operation === 'hot-cursor') {
                                peerInFlight = true;
                                try {
                                    peer = inTx(async writer => {
                                        if (replacement) await applyMachineReplacement({ tx: writer, accountId: changedMachine.accountId,
                                            oldMachineId: changedMachine.id, replacementMachineId: replacement.id, reason: 'manual',
                                            source: 'manual', actorUserId: changedMachine.accountId, confirmActiveOldMachine: true });
                                        else if (custodian) expect(await removeMachineAccessGrantInTx(writer, {
                                            actorAccountId: custodian.id, machineId: changedMachine.id,
                                            principal: { kind: 'account', accountId: f.account.id },
                                        })).toMatchObject({ kind: 'removed' });
                                        else await markAccountChanged(writer, { accountId: f.account.id, kind: 'account', entityId: 'signed-peer' });
                                    });
                                    if (pendingReplacement) await held.promise;
                                    else await peer;
                                    advances++;
                                } finally { peerInFlight = false; }
                            }
                            return Reflect.apply(query, model, values);
                        };
                    } });
                } })), ...args.slice(1)]);
            } });
            try {
                let responded = false;
                const responding = birth.send({ ...birth.body, creationAuthorizationProof: birth.proof }).then(response => {
                    responded = true;
                    return response;
                });
                if (pendingReplacement) {
                    await held.promise;
                    // There is no reciprocal Machine-binding write at Session birth:
                    // a foreign replacement can serialize after this admitted birth.
                    await expect.poll(() => responded).toBe(true);
                }
                const response = await responding;
                expect(advances).toBe(1);
                if (operation === 'hot-cursor' || pendingReplacement) {
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ created: true });
                    expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(1);
                    release.resolve();
                    await peer;
                } else {
                    expect(response.statusCode, response.body).toBe(401);
                    expect(await db.session.count({ where: { accountId: f.account.id } })).toBe(0);
                    expect(await db.sessionFollowEdge.count({ where: { sourceDiscussionId: birth.ref.discussionId } })).toBe(0);
                    expect(await db.accountChange.count({ where: { accountId: f.account.id, kind: 'session' } })).toBe(0);
                    expect(await db.discussionParticipant.findUniqueOrThrow({ where: { discussionId_participantSlotId: birth.ref } }))
                        .toMatchObject({ sessionId: null, removedAt: null });
                }
            } finally {
                release.resolve();
                db.$transaction = transaction;
                await peer;
                await f.app.close();
                await db.discussion.delete({ where: { id: birth.ref.discussionId } });
                await db.session.deleteMany({ where: { accountId: f.account.id } });
                await db.machine.deleteMany({ where: { id: { in: [f.machine.id, birth.target.id, ...(replacement ? [replacement.id] : [])] } } });
                await db.account.delete({ where: { id: f.account.id } });
                if (custodian) await db.account.delete({ where: { id: custodian.id } });
            }
        });
});
