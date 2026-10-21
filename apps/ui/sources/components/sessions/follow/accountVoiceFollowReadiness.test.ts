import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { ExecutionRunEnsureOrStartResponseSchema, ExecutionRunListResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { ExecutionRunStopResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

// Only Home/daemon transport is synthetic; readiness, Account, provider and
// execution owners below it run unchanged.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') {
            throw new Error('Expected Home RPC request');
        }
        const method = payload.method.slice(payload.method.indexOf(':') + 1);
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) {
            return { ok: true, result: ExecutionRunListResponseSchema.parse({ runs: [] }) };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
            || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
            return { ok: true, result: ExecutionRunEnsureOrStartResponseSchema.parse({ ok: true, runId: 'voice-run', created: true }) };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
            return { ok: true, result: ExecutionRunStopResponseSchema.parse({ ok: true }) };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
            return { ok: true, result: { error: 'Run not found', errorCode: 'execution_run_not_found' } };
        }
        throw new Error(`Unexpected daemon RPC: ${method}`);
    });
});

const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
const { useAccountVoiceFollowReadiness } = await import('./useAccountVoiceFollowReadiness');
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
import { resolveAccountVoiceFollowReadiness } from './accountVoiceFollowReadiness';

describe('useAccountVoiceFollowReadiness', () => {
    beforeEach(async () => {
        account = await createVoiceSettingsAccountTestHarness(settingsParse({
            experiments: true, featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
            voice: { providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                welcome: { enabled: false }, providers: { local_conversation: { schemaVersion: 1, config: {
                    conversationMode: 'agent', agent: { agentSource: 'agent', agentId: 'claude', prewarmOnConnect: false,
                        transcript: { persistenceMode: 'ephemeral', epoch: 0 } },
                } } } },
        }));
        const carrier = createSessionFixture({ id: 'voice-carrier', serverId: account.scope.serverId, active: true,
            metadata: { path: '/voice', host: 'test', flavor: 'claude' } });
        storage.setState({ sessions: {
            [carrier.id]: carrier,
            'session-1': createSessionFixture({ serverId: account.scope.serverId }),
        } });
        storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now(),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })], true, { sourceServerId: account.scope.serverId });
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        const request = account.request.getMockImplementation();
        if (!request) throw new Error('Account HTTP boundary missing');
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
            if (new URL(String(input)).pathname.endsWith('/messages')) {
                return Response.json(SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }));
            }
            return sessionHttp.handle(input, init) ?? request(input, init);
        }));
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: carrier.id,
            conversationSessionAddress: { serverId: account.scope.serverId, sessionId: carrier.id },
            targetSessionAddress: null, transcriptMode: 'native_session', lifetime: 'runtime_attempt', updatedAt: Date.now(),
        });
        await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
    });

    afterEach(async () => {
        standardCleanup();
        await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
        voiceSessionBindingStore.getState().unbind('voice-carrier');
        registerVoiceAdapters([]);
        await account?.dispose();
    });

    it('reads the source Session through the exact Home scope', async () => {
        const hook = await renderHook(() => useAccountVoiceFollowReadiness({
            sessionId: 'session-1',
            serverId: account.scope.serverId,
            initialSnapshotPending: false,
        }));

        expect(hook.getCurrent()).toBe('eligible');
        // The composed readiness path must stop admitting Follow when its
        // registered context owner disappears, and recover on registration.
        await act(async () => registerVoiceAdapters([]));
        expect(hook.getCurrent()).toBe('runtime_unsupported');
        await act(async () => registerVoiceAdapters([createLocalConversationVoiceAdapter()]));
        expect(hook.getCurrent()).toBe('eligible');
        // A same-id carrier hydrated from another Home is not this editor's
        // source. A bare-id read would incorrectly report waiting_encrypted.
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
            'session-1': createSessionFixture({ serverId: 'another-home', encryptionMode: 'e2ee' }),
        } })));
        expect(hook.getCurrent()).toBe('waiting_for_runtime');
    });
    it('does not treat an encrypted source as ready when the Account encryption authority is absent', async () => {
        expect(sync.encryption).toBeNull();
        storage.setState(state => ({ sessions: { ...state.sessions,
            'session-1': createSessionFixture({ serverId: account.scope.serverId, encryptionMode: 'e2ee' }),
        } }));
        const hook = await renderHook(() => useAccountVoiceFollowReadiness({
            sessionId: 'session-1',
            serverId: account.scope.serverId,
            initialSnapshotPending: false,
        }));

        expect(hook.getCurrent()).toBe('waiting_encrypted');
    });

    it('does not report missing encryption while the exact Home Session is loading', async () => {
        storage.setState(state => ({ sessions: { 'voice-carrier': state.sessions['voice-carrier']! } }));
        const hook = await renderHook(() => useAccountVoiceFollowReadiness({
            sessionId: 'session-1',
            serverId: account.scope.serverId,
            initialSnapshotPending: false,
        }));

        expect(hook.getCurrent()).toBe('waiting_for_runtime');
    });
});

describe('resolveAccountVoiceFollowReadiness', () => {
    const supportedMachine = { operationProtocolCapabilities: { sessionFollow: { contextV1: true } } };
    it('derives current runtime, capability, encryption, pending, and eligible states', () => {
        const base = { adapterPresent: true, scopeCurrent: true } as const;
        expect(resolveAccountVoiceFollowReadiness({ ...base, scopeCurrent: false, contextScope: 'session_context', machine: supportedMachine, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('waiting_for_runtime');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'session_context', machine: null, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('waiting_for_runtime');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'session_context', machine: { operationProtocolCapabilities: {} }, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('runtime_unsupported');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'current_ui_only', machine: supportedMachine, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('provider_withheld');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'current_ui_only', machine: null, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('provider_withheld');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'session_context', machine: supportedMachine, sourceEncrypted: true, sourceKeyReady: false, initialSnapshotPending: false })).toBe('waiting_encrypted');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'session_context', machine: supportedMachine, sourceEncrypted: true, sourceKeyReady: true, initialSnapshotPending: true })).toBe('pending');
        expect(resolveAccountVoiceFollowReadiness({ ...base, contextScope: 'session_context', machine: supportedMachine, sourceEncrypted: false, sourceKeyReady: true, initialSnapshotPending: false })).toBe('eligible');
    });
});
