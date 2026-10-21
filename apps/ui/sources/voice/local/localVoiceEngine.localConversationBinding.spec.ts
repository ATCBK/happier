import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import type { PartialOptions as ElevenLabsStartOptions } from '@elevenlabs/client';
import {
    getStorage, loadLocalVoiceEngineWithCompatState, registerLocalVoiceEngineHarnessHooks,
    machineRpcWithServerScope, localVoiceHomeId, localVoiceSpeechOutputBoundary, replaceLocalVoiceSessionHttpSeed,
    setLocalVoiceHttpResponder,
} from './localVoiceEngine.testHarness';

// Only the external SDK carrier is held; generated provider activation,
// preparation, ownership and published runtime transitions remain real.
const elevenLabsSdk = vi.hoisted(() => ({ startSession: vi.fn<(options: ElevenLabsStartOptions) => Promise<unknown>>() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: elevenLabsSdk.startSession } }));
// The native provider installs its strategy on this third-party SDK entry
// before calling the held carrier; the actual provider strategy stays real.
vi.mock('@elevenlabs/client/internal', () => ({
    setSetupStrategy: vi.fn(), createConnection: vi.fn(), setupWebRTCSession: vi.fn(),
}));

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

async function getLocalConversationSnapshot() {
    const { getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');
    return getVoiceAdapterRegistry().get('local_conversation')?.getSnapshot();
}

async function configureAgentMode(): Promise<void> {
    const storage = await getStorage();
    const previousServerSeedIds = Object.keys(storage.getState().sessions);
    const config = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({
        settings: {
            ...storage.getState().settings,
            voice: {
                ...storage.getState().settings.voice,
                providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                providers: {
                    ...storage.getState().settings.voice.providers,
                    local_conversation: { schemaVersion: 1, config: {
                        ...config,
                        conversationMode: 'agent',
                        agent: {
                            ...config.agent,
                            prewarmOnConnect: false,
                        },
                    } },
                },
            },
        },
        // Withhold the hidden carrier from the HTTP source so the real binding
        // owner must prepare it through canonical Session creation.
        sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: localVoiceHomeId,
            active: true, presence: 'online', metadata: { machineId: 'machine-1', path: '/workspace/project', host: 'voice.test',
                flavor: 'claude', agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } }) },
    });
    for (const id of [...previousServerSeedIds, 'session-1']) replaceLocalVoiceSessionHttpSeed(id);
}

type MachineRequest = Readonly<{ method: string; payload: unknown; machineId: string; serverId: string }>;
function interceptVoiceSpawn(beforeReply: (request: MachineRequest) => Promise<void>) {
    const incumbent = machineRpcWithServerScope.getMockImplementation();
    if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
    machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
        if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
            SessionSpawnNewInputV2Schema.parse(request.payload);
            await beforeReply(request);
        }
        return incumbent(request);
    });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine local conversation binding', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    it('resolves agent-mode device speech through the hidden global control session despite an offline speech Machine', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
            executionMachine: { mode: 'fixed', machineId: 'speech-offline' },
            providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                stt: { ...config.stt, provider: 'device' },
                tts: { ...config.tts, provider: 'device' },
            } } },
        } } });

        await localVoiceEngine.toggleLocalVoiceTurn('session-1');

        await vi.waitFor(async () => {
            const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
            expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toMatchObject({
                adapterId: 'local_conversation',
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                conversationSessionId: 'voice-home-session',
                targetSessionAddress: { serverId: localVoiceHomeId, sessionId: 'session-1' },
            });
        });
    }, 60_000);

    it.each(['stt', 'tts'] as const)('refuses an offline daemon %s Machine before preparing a carrier on the online root Machine', async (surface) => {
        await configureAgentMode();
        const storage = await getStorage();
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({
            machines: { ...storage.getState().machines,
                'speech-offline': createMachineFixture({ id: 'speech-offline', active: false, activeAt: 1 }),
            },
            settings: { ...storage.getState().settings, voice: { ...voice,
                executionMachine: { mode: 'fixed', machineId: 'speech-offline' },
                providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: { ...config,
                    stt: { ...config.stt, provider: surface === 'stt' ? 'local_neural' : 'device', localNeural: {
                        ...config.stt.localNeural, execution: 'daemon',
                    } },
                    tts: { ...config.tts, provider: surface === 'tts' ? 'local_neural' : 'device',
                        autoSpeakReplies: true, localNeural: { ...config.tts.localNeural, execution: 'daemon' } },
                } } },
            } },
        });
        const { resolveVoiceExecutionMachineSelectionFromState } = await import('@/voice/settings/executionMachine');
        expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState())).toEqual({
            kind: 'selected_unreachable', machineId: 'speech-offline',
        });
        let failure: unknown;
        try { await localVoiceEngine.toggleLocalVoiceTurn('session-1'); } catch (error) { failure = error; }

        expect(await getLocalConversationSnapshot()).toMatchObject({
            status: 'error', canStop: false,
            errorCode: 'execution_machine_unavailable', errorRecoveryAction: 'select_execution_machine',
        });
        expect(failure).toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
        expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
        expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    }, 60_000);

    it('publishes connecting for a targetless lifecycle start and admits its host-owned Voice Home creation', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        storage.__setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: {
                'session.spawn_new': { approvalRequiredSurfaces: ['voice'] },
            } },
        } });
        let resolveBinding!: () => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
        });

        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        const start = lifecycle.toggle(null);
        await Promise.race([start, vi.waitFor(() => expect(resolveBinding).toBeTypeOf('function'))]);
        const preparingSnapshot = await getLocalConversationSnapshot();
        resolveBinding();
        await start;

        expect(preparingSnapshot).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connecting',
            canStop: true,
        });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
        await lifecycle.dispose();
    }, 60_000);

    it('retains explicit UI approval custody as a typed Start refusal instead of parsing it as a spawned Session', async () => {
        await configureAgentMode();
        const storage = await getStorage();
        storage.__setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: {
                'session.spawn_new': { approvalRequiredSurfaces: ['ui'] },
            } },
        } });
        const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setLocalVoiceHttpResponder(request => artifacts.handle(request.path, {
            method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }) ?? undefined);
        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            await expect(lifecycle.toggle(null)).rejects.toMatchObject({ code: 'approval_request_created' });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'disconnected', errorMessage: 'approval_request_created', canStop: false,
            });
            expect(artifacts.list()).toHaveLength(1);
            expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toEqual([]);
        } finally {
            await lifecycle.dispose();
        }
    }, 60_000);

    it('surfaces a safe retryable error when hidden Voice Home preparation fails', async () => {
        await configureAgentMode();
        const preparationFailure = Object.assign(
            new Error('machine unavailable at /Users/private/repository'),
            { code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' },
        );
        interceptVoiceSpawn(async () => { throw preparationFailure; });

        // The real Session creation Action sanitizes a transport exception to
        // its public action_failed code; it does not forward a private backend
        // code injected below the strict daemon response boundary.
        await expect(localVoiceEngine.toggleLocalVoiceTurn('')).rejects.toMatchObject({ code: 'action_failed' });

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            errorCode: 'provider_error',
            errorMessage: 'action_failed',
            errorRecoveryAction: 'retry',
        });
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        expect(getVoiceConversationRuntimeSnapshot().error).toHaveProperty('cause.code', 'action_failed');
        expect(JSON.stringify(getVoiceConversationRuntimeSnapshot().error)).not.toContain(preparationFailure.message);
    }, 60_000);

    it('keeps a signed-out Agent refusal visible and offers authentication recovery before capture', async () => {
        await configureAgentMode();
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Missing canonical machine Socket boundary');
        machineRpcWithServerScope.mockImplementation(async (request: MachineRequest) => {
            if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
                SessionSpawnNewInputV2Schema.parse(request.payload);
                return SessionSpawnNewResultV1Schema.parse({
                    type: 'error', code: 'agent_signed_out', agentId: 'claude', retryable: false,
                });
            }
            return incumbent(request);
        });

        const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
        const lifecycle = createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_conversation');
        try {
            await expect(lifecycle.toggle(null)).rejects.toMatchObject({ code: 'agent_signed_out' });
            expect(lifecycle.getSnapshot()).toMatchObject({
                status: 'error', canStop: false,
                errorCode: 'authentication_required', errorMessage: 'agent_signed_out',
                errorRecoveryAction: 'connect_agent', errorPresentation: 'error',
            });
            expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        } finally {
            await lifecycle.dispose();
        }
    }, 60_000);

    it('does not start capture when Voice Home preparation settles after Stop', async () => {
        await configureAgentMode();
        let resolveBinding!: () => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((resolve) => {
                resolveBinding = resolve;
            });
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        await vi.waitFor(() => expect(resolveBinding).toBeTypeOf('function'));
        await localVoiceEngine.stopLocalVoiceSession();
        resolveBinding();
        await start;

        expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);

        expect(await getLocalConversationSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'disconnected',
            canStop: false,
        });
    }, 60_000);

    it('does not overwrite a newer adapter owner when stale Voice Home preparation fails', async () => {
        await configureAgentMode();
        let rejectBinding!: (error: Error) => void;
        interceptVoiceSpawn(async () => {
            await new Promise<void>((_resolve, reject) => {
                rejectBinding = reject;
            });
        });

        const start = localVoiceEngine.toggleLocalVoiceTurn('');
        void start.catch(() => {});
        await vi.waitFor(() => expect(rejectBinding).toBeTypeOf('function'));
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const storage = await getStorage();
        const [{ writeVoiceProviderSettingsConfig }, { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS },
            { createBuiltinVoiceAdapterAssembly }, { createSessionMetadataHttpBoundary },
            { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG },
            { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema },
            { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1 },
            { answerVoiceRealtimePreparationHttpRequest }, { PROMPT_LIBRARY_ROWS_ROUTE_V1 }] = await Promise.all([
            import('@/sync/domains/settings/voiceSettings'),
            import('../../../../../packages/plugins/elevenlabs/src/protocol/voice/index'),
            import('@/voice/adapters/registerBuiltinVoiceAdapters'),
            import('@/dev/testkit/harness/sessionMetadataHttpBoundary'),
            import('@/voice/persistence/voiceTranscriptHistorySession'),
            import('@happier-dev/protocol/sessions/control/contract'),
            import('@happier-dev/protocol'),
            import('@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary'),
            import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1'),
        ]);
        const voice = writeVoiceProviderSettingsConfig(storage.getState().settings.voice, providerId,
            ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
        storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice, providerId } } });
        const history = createSessionFixture({ id: 'binding-provider-history', serverId: localVoiceHomeId,
            encryptionMode: 'plain', active: false, metadata: { path: '/voice', host: 'test',
                ...buildVoiceTranscriptHistorySessionMetadata() } });
        const historyHttp = createSessionMetadataHttpBoundary(() => ({ [history.id]: history }));
        const owner = createSessionOwnerMetadataV1({ metadata: history.metadata });
        if (!owner.ok) throw new Error('Expected canonical history metadata owner');
        historyHttp.createSessionFromPost(history.id, { method: 'POST', body: JSON.stringify({
            tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: history.metadata, agentState: null })) },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
            agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
        }) });
        setLocalVoiceHttpResponder(request => {
            const init = { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
            if (request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return answerVoiceRealtimePreparationHttpRequest(
                request.url, storage.getState().settings) ?? undefined;
            if (request.path === '/v1/voice/token') return Response.json({ allowed: true, token: 'binding-provider-token',
                leaseId: 'binding-provider-lease', bindingNonce: 'binding-provider-nonce', expiresAtMs: Date.now() + 60_000 });
            if (request.path === '/v1/voice/session/complete' || request.path === '/v1/voice/session/release') return Response.json({ ok: true });
            if (request.path === '/v1/sessions' && request.method === 'POST') return historyHttp.createSessionFromPost(history.id, init);
            if (request.path === '/v2/sessions/lookup-by-tags') {
                const lookup = SessionLookupByTagsRequestV2Schema.parse(request.body);
                if (!lookup.tags.includes(VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG)) return undefined;
                const response = historyHttp.handle(`https://local-voice-actions.example.test/v2/sessions/${history.id}`);
                if (!response) throw new Error('Expected persisted history HTTP response');
                return response.json().then(body => Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [body.session] })));
            }
            if (request.path === `/v2/sessions/${history.id}` || request.path.startsWith(`/v2/sessions/${history.id}/`)) {
                return historyHttp.handle(request.url, init) ?? undefined;
            }
            return undefined;
        });
        let releaseSdk!: () => void;
        const sdkGate = new Promise<void>(resolve => { releaseSdk = resolve; });
        elevenLabsSdk.startSession.mockImplementation(async () => {
            await sdkGate;
            return { getId: () => 'binding-provider-conversation', endSession: async () => {},
                setMicMuted() {}, setVolume() {}, sendUserMessage() {}, sendContextualUpdate() {} };
        });
        const assembly = createBuiltinVoiceAdapterAssembly();
        const newerAdapter = assembly.adapters.find(adapter => adapter.id === providerId);
        if (!newerAdapter) throw new Error('Expected generated ElevenLabs adapter');
        const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const previousAdapters = getVoiceAdapterRegistry().list();
        registerVoiceAdapters(assembly.adapters);
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const newerStart = newerAdapter.start({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionAddress: null, initialContext: '' });
        void newerStart.catch(() => {});
        try {
            await vi.waitFor(() => expect(elevenLabsSdk.startSession).toHaveBeenCalledOnce());
            expect(newerAdapter.getSnapshot()).toMatchObject({ adapterId: providerId, status: 'connecting' });
            rejectBinding(Object.assign(new Error('stale local failure'), {
                code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE',
            }));
            await start;

            expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
                adapterId: providerId,
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                state: 'connecting',
                error: null,
            });
        } finally {
            rejectBinding(new Error('Binding fixture cleanup'));
            releaseSdk();
            await Promise.allSettled([start, newerStart]);
            await newerAdapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
            await assembly.dispose();
            registerVoiceAdapters(previousAdapters);
            setLocalVoiceHttpResponder(null);
        }
    }, 60_000);
});
