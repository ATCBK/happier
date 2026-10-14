import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Warm the real owner graph during collection, before behavior deadlines.
await prepareStandaloneVoicePolicyHarness();
await import('@/voice/adapters/localConversation/localConversationAdapter');

describe('real Local Voice Agent activation', () => {
    it('releases the old device handle on continuation without stopping the run reused by the new device', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off', dispatch: daemon.dispatch,
        });
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        const oldDevice = createVoiceExecutionTransport();
        const newDevice = createVoiceExecutionTransport();
        try {
            await oldDevice.ensureRunning(fixture.sessionId);
            const run = daemon.readRetainedRun();
            expect(run?.status).toBe('running');
            await newDevice.ensureRunning(fixture.sessionId);
            expect(daemon.readRetainedRun()?.runId).toBe(run?.runId);
            await oldDevice.stop(fixture.sessionId, 'continued_elsewhere');
            expect(oldDevice.isActive(fixture.sessionId)).toBe(false);
            expect(newDevice.isActive(fixture.sessionId)).toBe(true);
            expect(daemon.readRetainedRun()).toEqual(run);
            const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
            expect(readVoiceAgentRunMetadataFromSession({ sessionId: fixture.sessionId,
                serverId: fixture.handle.accountLifetime.scope.serverId })?.runId).toBe(run?.runId);
        } finally {
            await newDevice.stop(fixture.sessionId);
            await fixture.dispose();
        }
    });

    it('makes the hidden bound conversation active through the initializer and daemon transport, then retires its context sink', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({
            mode: 'off', initializeSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            existingSession: createSessionFixture({ id: 'hidden-voice', active: true, metadata: {
                path: '/voice', host: 'voice.test', flavor: 'claude',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }),
            dispatch: daemon.dispatch,
        });
        let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
        try {
            activation = await fixture.activateLocalAgent();
            expect(activation.controller.isAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
            const { resolveActiveLocalVoiceAgentBinding } = await import('@/voice/context/resolveActiveLocalVoiceAgentBinding');
            expect(resolveActiveLocalVoiceAgentBinding()).toMatchObject({
                operationalSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                announcementSessionId: 'hidden-voice',
                binding: { conversationSessionId: 'hidden-voice', transcriptMode: 'native_session' },
            });
            expect(activation.adapter.resolveContextChannel?.((await import('@/sync/domains/state/storage')).storage.getState().settings.voice))
                .toMatchObject({ hostAuthoredContext: 'session_context' });
            expect(daemon.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)).toBe(true);
            await activation.dispose();
            activation = undefined;
            expect(resolveActiveLocalVoiceAgentBinding()).toBeNull();
            expect(daemon.readRetainedRun()).toBeNull();
        } finally {
            await activation?.dispose();
            await fixture.dispose();
        }
    });
});
