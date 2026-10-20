import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
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
});
