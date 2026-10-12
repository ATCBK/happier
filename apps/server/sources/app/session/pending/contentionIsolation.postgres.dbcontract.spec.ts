import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { enqueuePendingMessageByAuthenticatedMachine } from './pendingMessageService';
import { mutateSessionBoard } from '@/app/session/board/service';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';

// Keep internal owners real; deterministic interleaving is at the Prisma boundary.
// Use only a disposable database, never the retained development stack.
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account cursor contention', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing ephemeral PostgreSQL DATABASE_URL');
        initDbPostgres();
        await db.$connect();
        expect(await initializeSessionSystemRecordsProtocolV1Activation(db)).toBe(true);
    });
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await db.$disconnect(); });

    it('commits two concurrent Board writes on one Account under ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: `contention-board-${randomUUID()}`, encryptionMode: 'plain' } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        let recordsWritten = 0;
        let transactionIndex = 0;
        const pids: number[] = [];
        const completed = new Set<number>();
        let releaseTransactions!: () => void;
        const bothTransactionsEntered = new Promise<void>(resolve => { releaseTransactions = resolve; });
        try {
            const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            } })));
            // Rendezvous at the real transaction boundary. After insertion,
            // allow the peer to insert or wait on a correctly acquired early
            // lock; the test must also admit a valid serialized implementation.
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    // Exercise the candidate isolation at the real database
                    // transport before activating the shared production default.
                    const options: unknown = args[1];
                    const candidateOptions = { ...(typeof options === 'object' && options !== null ? options : {}),
                        isolationLevel: 'ReadCommitted' };
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const index = transactionIndex++;
                        const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                        pids[index] = row.pid;
                        if (pids.length === 2) releaseTransactions();
                        await bothTransactionsEntered;
                        const records = new Proxy(tx.sessionSystemRecord, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (property !== 'create' || typeof method !== 'function') return method;
                                return async (...values: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, values);
                                    recordsWritten++;
                                    while (recordsWritten < 2 && !completed.has(1 - index)) {
                                        const [peer] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                                            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                                            pids[1 - index],
                                        );
                                        if (peer.waiting) break;
                                    }
                                    return row;
                                };
                            },
                        });
                        try {
                            return await Reflect.apply(operation, undefined, [new Proxy(tx, {
                                get(owner, property, receiver) {
                                    return property === 'sessionSystemRecord' ? records : Reflect.get(owner, property, receiver);
                                },
                            })]);
                        } finally { completed.add(index); }
                    }, candidateOptions]);
                },
            });
            const results = await Promise.allSettled(sessions.map(session => writeBoard(account.id, session.id)));
            for (const result of results) {
                if (result.status === 'rejected') throw result.reason;
                expect(result.value).toMatchObject({ ok: true, result: { outcome: 'created' } });
            }
            expect(recordsWritten).toBe(2);
            expect(await db.sessionSystemRecord.count({ where: { accountId: account.id } })).toBe(2);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 2 });
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(2);
        } finally {
            releaseTransactions();
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('commits first input after a heartbeat and Board write on the same Account under ReadCommitted', async () => {
        const account = await db.account.create({ data: { publicKey: `contention-three-${randomUUID()}` } });
        const originalTransaction = db.$transaction;
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', `srv_${'a'.repeat(32)}`);
        try {
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID(),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const sessions = await Promise.all([0, 1, 2].map(() => db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: '{}',
            } })));
            for (const session of sessions) await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'encrypted',
            } });
            const [destination, publisherSession, boardSession] = sessions;
            const socket = {};
            const presence = createSessionPublisherPresence();
            expect(await presence.registerPublisher({ socket,
                binding: { accountId: account.id, machineId: machine.id, sessionId: publisherSession.id },
                completeActivitySnapshot: { state: 'unknown', activeCount: 0 },
            })).toMatchObject({ status: 'registered' });
            let interleaved = false;
            db.$transaction = new Proxy(originalTransaction, {
                apply(target, thisArg, args) {
                    const operation: unknown = args[0];
                    if (typeof operation !== 'function') return Reflect.apply(target, thisArg, args);
                    const options: unknown = args[1];
                    const candidateOptions = { ...(typeof options === 'object' && options !== null ? options : {}),
                        isolationLevel: 'ReadCommitted' };
                    if (interleaved) return Reflect.apply(target, thisArg, [operation, candidateOptions]);
                    return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                        const session = new Proxy(tx.session, {
                            get(owner, property, receiver) {
                                const method: unknown = Reflect.get(owner, property, receiver);
                                if (typeof property !== 'string' || !property.startsWith('find') || typeof method !== 'function') return method;
                                return async (...values: unknown[]) => {
                                    const row: unknown = await Reflect.apply(method, owner, values);
                                    if (!interleaved) {
                                        interleaved = true;
                                        expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
                                        expect(await writeBoard(account.id, boardSession.id, 'e2ee')).toMatchObject({ ok: true });
                                    }
                                    return row;
                                };
                            },
                        });
                        return Reflect.apply(operation, undefined, [new Proxy(tx, {
                            get(owner, property, receiver) {
                                return property === 'session' ? session : Reflect.get(owner, property, receiver);
                            },
                        })]);
                    }, candidateOptions]);
                },
            });
            const localId = `three-first-${randomUUID()}`;
            expect(await enqueuePendingMessageByAuthenticatedMachine({
                accountId: account.id, sourceMachineId: machine.id, targetMachineId: machine.id,
                sessionId: destination.id, localId, content: { t: 'encrypted', c: 'first-input' },
                requestedAction: { v: 1, kind: 'enqueue' },
            })).toEqual({ status: 'accepted', localId });
            expect(interleaved).toBe(true);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: boardSession.id } })).toBe(1);
            expect(await db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: 'asc' },
                select: { sessionId: true, cursor: true } })).toEqual([
                { sessionId: publisherSession.id, cursor: 2 }, { sessionId: boardSession.id, cursor: 3 },
                { sessionId: destination.id, cursor: 4 },
            ]);
        } finally {
            db.$transaction = originalTransaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});

function writeBoard(accountId: string, sessionId: string, encryptionMode: 'plain' | 'e2ee' = 'plain') {
    return mutateSessionBoard({ actorUserId: accountId, sessionId,
        authentication: createPresentUserSessionAccessAuthentication(),
        mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null,
            itemContent: encryptionMode === 'e2ee' ? { t: 'encrypted', c: 'opaque-board-item' }
                : { t: 'plain', v: { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
                height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
                    document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } } },
    });
}
