import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionTurnMutationRoute } from './registerSessionTurnMutationRoute';
import { createRuntimeSessionClientDurableMutationOutbox } from '../../../../../../cli/src/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import { reloadConfiguration } from '../../../../../../cli/src/configuration';
import { loadSessionClientDurableMutationOutbox, loadSessionClientDurableMutationDeadLetters } from '../../../../../../cli/src/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';

describe('Session turn outbox → real HTTP admission', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-turnend-', initAuth: false });
        harness.resetEnv({ HAPPIER_HOME_DIR: harness.baseDir, HAPPIER_ACTIVE_SERVER_ID: 'turnend' });
        reloadConfiguration();
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
        reloadConfiguration();
    });

    it.each([false, true])('settles completion (invalid anchor: %s) and delivers the next turn', async (invalidAnchor) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        await db.sessionMessage.createMany({ data: [
            { sessionId: session.id, seq: 1, localId: 'prompt', messageRole: 'user', sidechainId: null, content: '{}' },
            { sessionId: session.id, seq: 2, localId: 'answer', messageRole: 'agent', sidechainId: null, content: '{}' },
        ] });
        const app = createAuthenticatedTestApp();
        // Only authentication is a fixture boundary. HTTP, route validation,
        // turn application, receipts and the disk journal are real.
        app.addHook('onRequest', async (request: FastifyRequest) => {
            request.headers['x-test-user-id'] = account.id;
        });
        registerSessionTurnMutationRoute(app);
        const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'fixture', serverUrl, sessionId: session.id, getSocket: () => null,
            requestReconnect: () => undefined,
        });
        const base = { v: 1 as const, sessionId: session.id, turnId: 'turn-1' };
        try {
            await outbox.awaitReady();
            await outbox.enqueueSessionTurnMutation({ ...base, action: 'begin', mutationId: 'begin', observedAt: 100 });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            await outbox.enqueueSessionTurnMutation({ ...base, action: 'complete', mutationId: 'complete', observedAt: 200,
                transcriptAnchors: invalidAnchor
                    ? { finalAssistantMessageSeq: 2 }
                    : { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
                        endSeqInclusive: 2, finalAssistantMessageSeq: 2 },
            });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            const letters = await loadSessionClientDurableMutationDeadLetters(session.id);
            if (invalidAnchor) {
                expect(letters).toEqual([expect.objectContaining({
                    mutationId: 'complete', reason: 'session_turn_mutation_rejected', attempts: 1,
                    lastAttempt: expect.objectContaining({ reason: 'session_turn_mutation_rejected' }),
                })]);
                expect(await db.sessionTurnMutationReceipt.count({ where: { sessionId: session.id, mutationId: 'complete' } })).toBe(0);
            } else {
                expect(letters).toEqual([]);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ latestTurnStatus: 'completed' });
                expect(await db.sessionTurnMutationReceipt.findUniqueOrThrow({
                    where: { sessionId_mutationId: { sessionId: session.id, mutationId: 'complete' } },
                })).toMatchObject({ decision: 'applied' });
            }
            await outbox.enqueueSessionTurnMutation({ ...base, turnId: 'turn-2', action: 'begin', mutationId: 'next', observedAt: 300 });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
                latestTurnId: 'turn-2', latestTurnStatus: 'in_progress',
            });
        } finally {
            await outbox.close();
            await app.close();
        }
    });
});
