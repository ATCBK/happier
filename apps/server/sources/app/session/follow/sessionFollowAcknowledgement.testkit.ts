import { randomUUID } from 'node:crypto';
import { decodeBase64 } from 'privacy-kit';
import { expect, vi } from 'vitest';
import {
    SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
    SessionFollowAcknowledgeRequestV1Schema, SessionFollowAcknowledgeResponseV1Schema,
    SessionFollowObservePendingResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { setSessionFollowSource } from './sessionFollowEdgeService';
import { setSessionManager } from './sessionManagerService';
import { logger } from '@/utils/logging/log';

/** Only the socket transport is substituted; publisher, access, schema and ACK owners are real. */
export async function assertConcurrentFailedTurnRouteAcknowledgements(options: Readonly<{
    duringObservation?: (input: Readonly<{
        accountId: string;
        presence: ReturnType<typeof createSessionPublisherPresence>;
        socket: object;
        observe: () => Promise<ReturnType<typeof SessionFollowObservePendingResponseV1Schema.parse>>;
    }>) => Promise<ReturnType<typeof SessionFollowObservePendingResponseV1Schema.parse>>;
    duringAcknowledgements?: (input: Readonly<{
        accountId: string;
        presence: ReturnType<typeof createSessionPublisherPresence>;
        socket: object;
        acknowledge: () => Promise<void>;
    }>) => Promise<void>;
}> = {}) {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    const presence = createSessionPublisherPresence();
    const socket = createAuthenticatedFakeSocket({ id: randomUUID(), nsp: {
        server: createSocketRoomDiscoveryHarness(async () => []),
    } });
    try {
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } } } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', seq: 2, agentStateVersion: 2 } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id,
            data: MACHINE_PLAIN_DATA_KEY_MARKER } });
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: destination.id };
        expect(await presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } }))
            .toMatchObject({ status: 'registered' });
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'session-scoped', socket,
            userId: owner.id, sessionId: destination.id } as never, { presence, binding });
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id,
            managerSessionId: destination.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        expect(await setSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id,
            destinationSessionId: destination.id, policy: { preset: 'quiet' }, authentication })).toMatchObject({ ok: true });
        await db.session.update({ where: { id: source.id }, data: { seq: 2,
            latestTurnId: 'session-turn:failed-source', latestTurnStatus: 'failed' } });
        const observe = async () => {
            let rawObservation: unknown;
            await getSocketHandler(socket, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1)({ v: 1,
                sessionId: destination.id, includeManager: true, supportsWakeAdmission: true },
            (value: unknown) => { rawObservation = value; });
            return SessionFollowObservePendingResponseV1Schema.parse(rawObservation);
        };
        const observation = options.duringObservation
            ? await options.duringObservation({ accountId: owner.id, presence, socket, observe })
            : await observe();
        expect(observation.ok).toBe(true);
        if (!observation.ok) throw new Error('Expected current publisher observation');
        const routes = observation.observations.filter(row => 'relation' in row);
        expect(routes).toHaveLength(2);
        expect(routes.find(row => row.relation === 'manager')?.delivered.agentStateVersion).toBe(1);
        expect(routes.find(row => row.relation === 'follower')?.delivered.agentStateVersion).toBe(2);
        const localInputId = randomUUID();
        // Persist the destination-scoped accepted native input named by both route ACKs.
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: localInputId,
            messageRole: 'user', acceptedTurnId: 'accepted-destination-turn',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue with the worker result' } } } } });
        const requests = routes.map(row => {
            const request = SessionFollowAcknowledgeRequestV1Schema.parse({ v: 1,
            destinationSessionId: destination.id, sourceSessionId: source.id,
            expectedPublisherGeneration: observation.publisherGeneration, relation: row.relation,
            ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}), policy: row.policy,
            expected: row.delivered, observed: row.observed, consumed: row.observed,
            acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: 1 } });
            if (!('consumed' in request)) throw new Error('Expected source frontier ACK');
            return request;
        });
        const acknowledge = async (request: typeof requests[number]) => {
            let response: unknown;
            await getSocketHandler(socket, SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1)(request,
                (value: unknown) => { response = value; });
            return SessionFollowAcknowledgeResponseV1Schema.parse(response);
        };
        // Clock is a system boundary: exceed the owning acquisition budget
        // without sleeping or changing it. PostgreSQL may first exhaust the
        // feature-read snapshot; confirmed rollback must also remain retryable.
        const { maxWaitMs } = readDatabaseTransactionConfigFromEnv(process.env, getDbProviderFromEnv(process.env, 'postgres'));
        let now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += maxWaitMs + 1);
        try {
            expect(await acknowledge(requests[0]!)).toEqual({ ok: false, v: 1, error: 'retryable' });
        } finally { clock.mockRestore(); }
        // A real persistence failure must retain a typed cause without logging
        // Prisma's query arguments, native input or opaque payloads.
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        await db.$executeRawUnsafe('ALTER TABLE "SessionFollowEdge" RENAME COLUMN "policyJson" TO "unavailablePolicyJson"');
        try {
            expect(await acknowledge(requests[0]!)).toEqual({ ok: false, v: 1, error: 'internal' });
            expect(warning.mock.calls).toEqual(expect.arrayContaining([[
                expect.objectContaining({ module: 'websocket', level: 'warn',
                    operation: 'session_follow_acknowledge', phase: 'frontier',
                    causes: [{ name: 'PrismaClientKnownRequestError', code: 'P2022' }] }),
                'Session Follow acknowledgment failed',
            ]]));
        } finally {
            await db.$executeRawUnsafe('ALTER TABLE "SessionFollowEdge" RENAME COLUMN "unavailablePolicyJson" TO "policyJson"');
            warning.mockRestore();
        }
        const acknowledgeBoth = async () => {
            expect(await Promise.all(requests.map(acknowledge))).toEqual(requests.map(request => ({ ok: true, v: 1,
                destinationSessionId: destination.id, sourceSessionId: source.id, delivered: request.consumed })));
        };
        if (options.duringAcknowledgements) {
            await options.duringAcknowledgements({ accountId: owner.id, presence, socket, acknowledge: acknowledgeBoth });
        } else await acknowledgeBoth();
        const edges = await db.sessionFollowEdge.findMany({ where: { destinationSessionId: destination.id } });
        expect(edges).toHaveLength(2);
        for (const edge of edges) expect(edge).toMatchObject({ deliveredTranscriptSeq: 2, deliveredReadyEventSeq: 0,
            deliveredAgentStateVersion: 2, deliveredTurnId: 'session-turn:failed-source', deliveredTurnStatus: 'failed' });
        // A duplicate retains the typed CAS refusal; it cannot throw or regress progress.
        const semanticWarning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            expect(await acknowledge(requests[0]!)).toEqual({ ok: false, v: 1, error: 'stale_expected_frontier' });
            expect(semanticWarning.mock.calls).toContainEqual([
                expect.objectContaining({ operation: 'session_follow_acknowledge', phase: 'frontier',
                    destinationSessionId: destination.id, sourceSessionId: source.id,
                    causes: [{ name: 'SessionFollowAcknowledgeRefusal', code: 'stale_expected_frontier' }] }),
                'Session Follow acknowledgment failed',
            ]);
        } finally { semanticWarning.mockRestore(); }
        // A superseded socket cannot borrow the successor's current generation,
        // even with a valid accepted input and an otherwise-current route tuple.
        const successorSocket = {};
        const successor = await presence.registerPublisher({ socket: successorSocket, binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        expect(successor.status).toBe('registered');
        try {
            if (successor.status !== 'registered') throw new Error('Expected successor publisher');
            expect(await acknowledge({ ...requests[0]!, expected: requests[0]!.consumed,
                expectedPublisherGeneration: successor.publisherGeneration.toString() }))
                .toEqual({ ok: false, v: 1, error: 'stale_publisher_generation' });
        } finally { await presence.forgetDisconnectedPublisher({ socket: successorSocket }); }
    } finally {
        await presence.forgetDisconnectedPublisher({ socket });
        // The disposable DB harness owns teardown of these related rows.
    }
}
