import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

import {
    buildVoiceTranscriptHistorySessionMetadata,
    isVoiceTranscriptHistorySession,
    resolveDirectMediaTranscriptSession,
    runVoiceTranscriptHistoryCarrierOperation,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from './voiceTranscriptHistorySession';

// Load the cold Account/Sync graph during collection, after the Socket boundary.
const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');

afterEach(() => standardCleanup());

describe('voice transcript history session', () => {
    it('uses the approved hosted hidden-session identity', () => {
        expect(VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG)
            .toBe('system:voice-transcript-history:v1');
        expect(buildVoiceTranscriptHistorySessionMetadata()).toEqual({
            systemSessionV1: {
                v: 1,
                key: 'voice_transcript_history',
                hidden: true,
            },
        });
        expect(isVoiceTranscriptHistorySession({
            active: false,
            metadata: buildVoiceTranscriptHistorySessionMetadata(),
        })).toBe(true);
        expect(isVoiceTranscriptHistorySession({
            active: true,
            metadata: buildVoiceTranscriptHistorySessionMetadata(),
        })).toBe(false);
    });

    it('hydrates and returns a real requested target session without acquiring history', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        onTestFinished(account.dispose);
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('@/sync/sync');
        const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
        const target = createSessionFixture({ id: 'target-session', serverId: account.scope.serverId });
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [target.id]: target }));
        const request = account.request.getMockImplementation();
        if (!request) throw new Error('Account HTTP boundary missing');
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => sessionHttp.handle(input, init) ?? request(input, init)));
        storage.setState({ sessions: {} });

        await expect(resolveDirectMediaTranscriptSession({
            ensureTargetSession: async sessionId => {
                const hydrated = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    forceRefresh: true, serverId: account.scope.serverId,
                });
                if (hydrated.kind !== 'available' || hydrated.sessionId !== sessionId) throw new Error('Target not hydrated');
            },
            ensureHistorySession: async () => (await sync.ensureHostedSystemSession({
                tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
                metadata: buildVoiceTranscriptHistorySessionMetadata(),
            })).sessionId,
        }, {
            requestedTargetSessionId: ' target-session ',
        })).resolves.toBe('target-session');

        expect(storage.getState().sessions[target.id]?.metadata).toEqual(target.metadata);
        expect(account.request.mock.calls.some(([input, init]) =>
            new URL(String(input)).pathname === '/v1/sessions' && init?.method === 'POST')).toBe(false);
    });

    it('acquires targetless history through the hosted owner', async () => {
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        onTestFinished(account.dispose);
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('@/sync/sync');
        const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
        const historySessionId = 'history-session';
        // This is a current hosted resource created by the real owner POST,
        // rather than a flat legacy Session candidate requiring migration.
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({}));
        const request = account.request.getMockImplementation();
        if (!request) throw new Error('Account HTTP boundary missing');
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/sessions' && init?.method === 'POST') return sessionHttp.createSessionFromPost(historySessionId, init);
            return sessionHttp.handle(input, init) ?? request(input, init);
        }));
        storage.setState({ sessions: {} });

        await expect(resolveDirectMediaTranscriptSession({
            ensureTargetSession: async sessionId => {
                const hydrated = await sync.ensureSessionVisibleForMessageRoute(sessionId, { serverId: account.scope.serverId });
                if (hydrated.kind !== 'available') throw new Error('Target not hydrated');
            },
            ensureHistorySession: async () => (await sync.ensureHostedSystemSession({
                tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
                metadata: buildVoiceTranscriptHistorySessionMetadata(),
            })).sessionId,
        }, {
            requestedTargetSessionId: null,
        })).resolves.toBe('history-session');

        expect(isVoiceTranscriptHistorySession(storage.getState().sessions[historySessionId])).toBe(true);
        expect(account.request.mock.calls.filter(([input, init]) =>
            new URL(String(input)).pathname === '/v1/sessions' && init?.method === 'POST')).toHaveLength(1);
    });

    it('releases same-device carrier serialization after an operation rejects', async () => {
        await expect(runVoiceTranscriptHistoryCarrierOperation(async () => {
            throw new Error('delete failed');
        })).rejects.toThrow('delete failed');

        await expect(runVoiceTranscriptHistoryCarrierOperation(async () => (
            'later acquisition'
        ))).resolves.toBe('later acquisition');
    });
});
