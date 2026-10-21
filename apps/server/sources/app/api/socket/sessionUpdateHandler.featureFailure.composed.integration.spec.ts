import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1,
    SessionFollowObservePendingRequestV1Schema, SessionFollowObservePendingResponseV1Schema,
    SessionFollowAcknowledgeRequestV1Schema, SessionFollowAcknowledgeResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import {
    ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1, ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
    AccountVoiceFollowObservePendingRequestV1Schema, AccountVoiceFollowObservePendingResponseV1Schema,
    AccountVoiceFollowAcknowledgeRequestV1Schema, AccountVoiceFollowAcknowledgeResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/accountVoiceFollowTransportV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import {
    DISCUSSION_AGENT_POST_EVENT_V1,
    DiscussionAgentPostRequestV1Schema, DiscussionAgentPostResponseV1Schema,
} from '@happier-dev/protocol/discussions/api';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { logger } from '@/utils/logging/log';
import { sessionUpdateHandler } from './sessionUpdateHandler';
import { inTx, type Tx } from '@/storage/inTx';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { updateAccountFollowCreationPreferencesInTx } from '@/app/session/follow/accountFollowCreationPreferences';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { enqueuePendingMessageByAuthenticatedMachine, materializeNextPendingMessage } from '@/app/session/pending/pendingMessageService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { readSessionMessageReplyInTx } from '@/app/session/messages/sessionMessageReply';

const sessionId = randomUUID();
const sourceSessionId = randomUUID();
const frontier = SESSION_FOLLOW_ZERO_FRONTIER_V1;
const cases = [
    {
        event: SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
        request: SessionFollowObservePendingRequestV1Schema.parse({ v: 1, sessionId }),
        response: SessionFollowObservePendingResponseV1Schema,
        failure: 'internal', disabled: 'unsupported', denied: 'forbidden',
    },
    {
        event: SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1,
        request: SessionFollowAcknowledgeRequestV1Schema.parse({ v: 1,
            destinationSessionId: sessionId, sourceSessionId, expectedPublisherGeneration: '1',
            policy: { preset: 'important' },
            expected: frontier, observed: frontier, consumed: frontier,
            acceptance: { kind: 'admitted_input', localInputId: 'input', userMessageSeq: null },
        }),
        response: SessionFollowAcknowledgeResponseV1Schema,
        failure: 'internal', disabled: 'unsupported', denied: 'forbidden',
    },
    {
        event: ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1,
        request: AccountVoiceFollowObservePendingRequestV1Schema.parse({ v: 1,
            voiceSessionId: sessionId, executionRunId: 'voice-run',
        }),
        response: AccountVoiceFollowObservePendingResponseV1Schema,
        failure: 'internal', disabled: 'unsupported', denied: 'forbidden',
    },
    {
        event: ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
        request: AccountVoiceFollowAcknowledgeRequestV1Schema.parse({ v: 1,
            voiceSessionId: sessionId, executionRunId: 'voice-run', expectedExecutionRunOccurrenceId: 'occurrence',
            sourceSessionId, expectedPublisherGeneration: '1', expected: null, observed: frontier, consumed: frontier,
            acceptance: { localInputId: 'input', userMessageSeq: null },
        }),
        response: AccountVoiceFollowAcknowledgeResponseV1Schema,
        failure: 'internal', disabled: 'unsupported', denied: 'forbidden',
    },
    {
        event: DISCUSSION_AGENT_POST_EVENT_V1,
        request: DiscussionAgentPostRequestV1Schema.parse({ v: 1, sessionId,
            discussionId: randomUUID(), request: { localId: 'agent-message',
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } }, mentionedAccountIds: [],
            },
        }),
        response: DiscussionAgentPostResponseV1Schema,
        failure: 'discussions_unavailable', disabled: 'discussions_unavailable',
        denied: 'discussion_post_denied',
    },
] as const;

describe('Session socket Home feature read failure containment', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-socket-feature-failure-' });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(cases)('ACKs $event DB failure and keeps the same transport usable', async testCase => {
        harness.resetEnv({ HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' });
        const http = createServer();
        const io = new Server(http, { transports: ['websocket'] });
        io.on('connection', socket => {
            // Authentication is the network boundary; feature/config/domain logic stays real.
            Object.assign(socket.data, { userId: 'feature-reader', clientType: 'user-scoped', authAuthority: 'present_user' });
            sessionUpdateHandler('feature-reader', socket, { connectionType: 'user-scoped', socket, userId: 'feature-reader' });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Socket listener unavailable');
        const client = connect(`http://127.0.0.1:${address.port}`, {
            transports: ['websocket'], reconnection: false, autoConnect: false,
        });
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
                client.connect();
            });
            // Make the real configuration read fail in this disposable DB only.
            // SQLite has no Postgres pool acquisition error; a missing table
            // exercises the same awaited DB rejection without mocking domain logic.
            await db.$executeRawUnsafe('ALTER TABLE "HomeSettings" RENAME TO "UnavailableHomeSettings"');
            try {
                const response: unknown = await client.timeout(1_000).emitWithAck(testCase.event, testCase.request);
                expect(testCase.response.parse(response)).toEqual({ ok: false, v: 1, error: testCase.failure });
                if (testCase.event === SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1) {
                    expect(warning.mock.calls).toEqual(expect.arrayContaining([[
                        expect.objectContaining({ module: 'websocket', operation: 'session_follow_acknowledge', phase: 'feature',
                            causes: [{ name: 'PrismaClientKnownRequestError', code: 'P2021' }] }),
                        'Session Follow acknowledgment failed',
                    ]]));
                } else {
                    expect(warning.mock.calls.some(([fields, message]) => typeof fields === 'object' && fields !== null
                        && 'module' in fields && fields.module === 'websocket'
                        && typeof message === 'string' && message.includes('HomeSettings'))).toBe(true);
                    if (testCase.event === SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1) {
                        expect(warning.mock.calls.some(([fields]) => typeof fields === 'object' && fields !== null
                            && 'destinationSessionId' in fields && fields.destinationSessionId === sessionId)).toBe(true);
                    }
                }
            } finally {
                await db.$executeRawUnsafe('ALTER TABLE "UnavailableHomeSettings" RENAME TO "HomeSettings"');
            }
            // Real reads recover on this connection; a disabled feature remains fail-closed.
            process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '0';
            process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = '0';
            const disabled: unknown = await client.timeout(1_000).emitWithAck(testCase.event, testCase.request);
            expect(testCase.response.parse(disabled)).toEqual({ ok: false, v: 1, error: testCase.disabled });
            process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '1';
            process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = '1';
            const denied: unknown = await client.timeout(1_000).emitWithAck(testCase.event, testCase.request);
            expect(testCase.response.parse(denied)).toEqual({ ok: false, v: 1, error: testCase.denied });
            const invalid: unknown = await client.timeout(1_000).emitWithAck(testCase.event, {});
            expect(testCase.response.parse(invalid)).toEqual({ ok: false, v: 1,
                error: testCase.event === DISCUSSION_AGENT_POST_EVENT_V1
                    ? 'discussion_invalid_content' : 'invalid_request' });
            expect(client.connected).toBe(true);
        } finally {
            warning.mockRestore();
            client.disconnect();
            await new Promise<void>(resolve => io.close(() => resolve()));
        }
    });

    it.each(['connected', 'disconnected'] as const)('outlives the former five-second Follow cutoff with real Pending delivery (%s)', async lifetime => {
        harness.resetEnv({ HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const authentication = createPresentUserSessionAccessAuthentication();
        const homeId = await getOrCreateServerIdentityId();
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true }, sessionInputAdmission: { protocolVersions: [1, 2] },
                sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const receiver = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: receiver.id, data: 'opaque' } });
        await inTx(tx => updateAccountFollowCreationPreferencesInTx(tx, { accountId: account.id,
            patch: { discussionReceivePolicy: { preset: 'quiet' } } }));
        const created = await createDiscussion({ actorAccountId: account.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'A deliberate draft question' } }, firstMessage: { localId: randomUUID(),
                content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Context' }] } }, mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: account.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: receiver.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const question = await postDiscussionMessage({ actorAccountId: account.id, authentication, discussionId, request: { localId: randomUUID(),
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: receiver.id } },
                { t: 'text', text: 'Answer this question' }] } }, mentionedAccountIds: [], mentionedSessionIds: [receiver.id] } });
        if (!question.ok) throw new Error(question.error);
        const addressing = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: receiver.id };
        // This host executes the canonical Pending admission below, so it can
        // truthfully consume wake work when autonomous exchange is enabled.
        const observeRequest = SessionFollowObservePendingRequestV1Schema.parse({ v: 1, sessionId: receiver.id, supportsWakeAdmission: true });
        const http = createServer(), io = new Server(http, { transports: ['websocket'] });
        const presence = createSessionPublisherPresence();
        const disconnected: Promise<unknown>[] = [];
        let publisherSocket: Socket | undefined;
        io.on('connection', socket => {
            publisherSocket = socket;
            // Network admission is the boundary; registration, publisher
            // currentness, Follow policy, SQLite and Pending stay real.
            Object.assign(socket.data, { clientType: 'session-scoped', sessionId: receiver.id, machineId: machine.id, authAuthority: 'present_user' });
            sessionUpdateHandler(account.id, socket, { connectionType: 'session-scoped', socket, userId: account.id, sessionId: receiver.id },
                { presence, binding: { accountId: account.id, sessionId: receiver.id, machineId: machine.id } });
            socket.on('disconnect', () => { disconnected.push(presence.forgetDisconnectedPublisher({ socket })); });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Socket listener unavailable');
        const client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false, autoConnect: false });
        const connectPublisher = async () => {
            await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); client.connect(); });
            expect(await client.emitWithAck('session-runtime-activity-snapshot', { sessionId: receiver.id,
                mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: expect.stringMatching(/^(applied|unchanged)$/) });
        };
        const transaction = db.$transaction;
        let delayed = false;
        let queryStarted!: () => void;
        const started = new Promise<void>(resolve => { queryStarted = resolve; });
        try {
            await connectPublisher();
            expect(await inTx(tx => readCurrentCommittedSessionInputMachineTargetInTx(tx, receiver.id))).toMatchObject({
                accountId: account.id, sessionId: receiver.id, machineId: machine.id, homeId, installationId: machine.installationId,
            });
            const baseline = SessionFollowObservePendingResponseV1Schema.parse(await client.emitWithAck(
                SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, observeRequest));
            expect(baseline, 'the exact original is available before delaying storage').toMatchObject({ ok: true, observations: [{ addressing }] });
            // Schedule one real DB query beyond the obsolete five-second
            // request cap, within SQLite's unchanged canonical transaction
            // budget. Native transaction expiry/rollback and retry stay real.
            db.$transaction = new Proxy(transaction, { apply(target, transactionReceiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, transactionReceiver, args);
                return Reflect.apply(target, transactionReceiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'session') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.session, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: unknown[]) => {
                            const query = queryArgs[0];
                            const targetRead = query !== null && typeof query === 'object' && 'where' in query
                                && query.where !== null && typeof query.where === 'object' && 'id' in query.where
                                && query.where.id === receiver.id && 'select' in query && query.select !== null
                                && typeof query.select === 'object' && 'publisherGenerationLastActiveAt' in query.select;
                            if (!delayed && targetRead) { delayed = true; queryStarted(); await new Promise(resolve => setTimeout(resolve, 5_250)); }
                            return Reflect.apply(model.findUnique, model, queryArgs);
                        };
                    } });
                } })), ...args.slice(1)]);
            } });
            const observed = client.emitWithAck(SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, observeRequest);
            const observationOutcome = Promise.allSettled([observed]);
            await started;
            if (lifetime === 'disconnected') {
                const transportClosed = new Promise<void>(resolve => { publisherSocket!.once('disconnect', () => resolve()); });
                client.disconnect();
                expect((await observationOutcome)[0]).toMatchObject({ status: 'rejected' });
                // The production disconnect owner retires the actual publisher;
                // observing must not consume the question or manufacture Pending.
                await transportClosed;
                await Promise.all(disconnected);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(0);
                await connectPublisher();
            }
            const response = SessionFollowObservePendingResponseV1Schema.parse(lifetime === 'connected' ? await observed
                : await client.emitWithAck(SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, observeRequest));
            expect(response, `the exact original remains available after ${lifetime} storage wait`).toMatchObject({ ok: true, observations: [{ policy: { preset: 'quiet' },
                event: { kind: 'needs_you', type: 'decision', mode: 'wait' }, addressing }] });
            const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
            const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
                discussionAddressing: addressing, replyIntent: { mode: 'return' } });
            const enqueued = await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id,
                targetMachineId: machine.id, sessionId: receiver.id, localId, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Answer this question' },
                    meta: withSessionInputRequestV1({}, request) } }, reply: { mode: 'return', discussion: addressing } });
            expect(enqueued.status, JSON.stringify(enqueued)).toBe('accepted');
            expect(enqueued).toMatchObject({ localId });
            const claim = await presence.runAsCurrentPublisher({ socket: publisherSocket!, operation: authority => materializeNextPendingMessage({
                actorUserId: account.id, sessionId: receiver.id, publisherAuthority: authority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }) });
            expect(claim).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
            // The canonical original reader spans Pending custody and the later
            // transcript publication after separate admission settlement.
            expect(await inTx(tx => readSessionMessageReplyInTx(tx, { accountId: account.id,
                sessionId: receiver.id, localId, authentication }))).toMatchObject({ status: 'available',
                progress: { mode: 'return', discussion: addressing } });
        } finally {
            db.$transaction = transaction;
            client.disconnect();
            await new Promise<void>(resolve => io.close(() => resolve()));
            await Promise.all(disconnected);
        }
    });
});
