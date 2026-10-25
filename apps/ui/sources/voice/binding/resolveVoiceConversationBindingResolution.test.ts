import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForTestEvent } from '@/dev/testkit';
import type { BuiltinVoiceAdapterAssembly } from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';

const nativeAlertCalls = vi.hoisted(() => {
  const calls: Parameters<typeof import('react-native')['Alert']['alert']>[] = [];
  return calls;
});
const nativeAlertObservers = vi.hoisted(() => new Set<() => void>());
const subscribeNativeAlert = (notify: () => void) => {
  nativeAlertObservers.add(notify);
  return () => { nativeAlertObservers.delete(notify); };
};

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' }, {
    Alert: {
      // Native presentation/user input is external; Modal.confirm stays real.
      alert: (...args: Parameters<typeof import('react-native')['Alert']['alert']>) => {
        nativeAlertCalls.push(args);
        for (const notify of nativeAlertObservers) notify();
      },
    },
  });
});

// Install external transports before any runtime consumer reaches Sync.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { sync } = await import('@/sync/sync');
const { createBuiltinVoiceAdapterAssembly } = await import('@/voice/adapters/registerBuiltinVoiceAdapters');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
const { writeVoiceConversationScopeMetadata, readVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
const { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } = await import('@/voice/persistence/voiceConversationSession');
const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
const { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } = await import('@/voice/persistence/voiceAutoTargetMachineSettings');
const { clearVoiceAgentRecoveryReplaySource, readVoiceAgentRecoveryReplaySource } = await import('@/voice/agent/voiceAgentRecoveryReplayState');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { voiceSessionBindingStore } = await import('./voiceConversationBindingStore');
const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');

const localSettings = (stayInVoiceHome = false) => settingsParse({ lastUsedAgent: 'codex', voice: {
  executionMachine: { mode: 'auto', machineId: null },
  providers: { local_conversation: { schemaVersion: 1, config: {
    conversationMode: 'agent', agent: { backend: 'daemon', stayInVoiceHome, rootSessionPolicy: 'keep_warm', maxWarmRoots: 5 },
  } } },
} });

describe('ensureVoiceConversationBindingResolution', () => {
  let assembly: BuiltinVoiceAdapterAssembly;
  let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
  let metadata: ReturnType<typeof createSessionMetadataHttpBoundary>;
  let machineRows: ReturnType<typeof createPlainMachineRowFixture>[];
  const address = (sessionId: string) => ({ serverId: connection.home.id, sessionId });

  function carrier(id: string, rootId?: string, machineId = 'machine-1', updatedAt = 1) {
    return createSessionFixture({ id, serverId: connection.home.id, active: true, updatedAt,
      metadata: writeVoiceConversationScopeMetadata({ path: rootId ? `/project/${rootId}` : '/Users/tester/.happy-dev/voice-agent',
        host: 'tester.local', machineId, flavor: 'codex',
        permissionMode: readLocalConversationVoiceSettings(localSettings().voice).agent.permissionIntent,
        ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
      }, rootId ? { kind: 'session_root', sessionRootId: rootId } : { kind: 'voice_home' }),
    });
  }

  beforeEach(async () => {
    nativeAlertCalls.length = 0;
    network.resetRequests();
    clearDaemonMergedProjectionCacheForTests();
    clearVoiceAgentRecoveryReplaySource('__voice_agent__');
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {}, primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
    const home = await network.addHome('https://voice-binding.example.test', 'account-binding');
    machineRows = [createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-binding' })];
    metadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    network.setRpcAckResponder(async request => {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
        return { ok: false, error: 'RPC method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
      if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        const input = SessionResumeRequestV1Schema.parse(request.payload);
        return { ok: true, result: { type: 'success', sessionId: input.sessionId } satisfies import('@happier-dev/protocol').SpawnSessionResult };
      }
      throw new Error(`Unexpected daemon effect: ${request.method}`);
    });
    const request = createSessionReadBatchFetchBoundary(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
      const purposeResponse = await purposes.handle(input, init);
      if (purposeResponse) return purposeResponse;
      const path = new URL(String(input)).pathname;
      if (path === '/health') return Response.json({});
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: localSettings() }, version: 1 });
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } });
      if (path === '/v1/machines') return Response.json(machineRows);
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => machineRows.find(row => row.id === id) ?? null);
      if (path.startsWith('/v1/machines/') && !path.endsWith('/access'))
        return Response.json({ machine: machineRows.find(row => row.id === decodeURIComponent(path.split('/')[3]!)) });
      if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
      if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
      return metadata.handle(input, init);
    });
    network.setHttpResponder(request);
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'account-binding', credentialScope: 'restored-home', request });
    await sync.refreshMachines();
    const scope = { serverId: connection.home.id, accountId: 'account-binding' };
    storage.setState({ settings: localSettings(), settingsScope: scope, profileScope: scope, sessions: {} });
    storage.setState({ sessions: Object.fromEntries([
      carrier('voice-home'),
      ...['s1', 's2', 's9'].flatMap(id => [createSessionFixture({ id, serverId: connection.home.id,
        metadata: { machineId: 'machine-1', path: `/project/${id}`, host: 'tester.local', flavor: 'codex' } }), carrier(`voice-root-${id}`, id)]),
    ].map(session => [session.id, session])) });
    resetVoiceAdapterRegistryForTests();
    assembly = createBuiltinVoiceAdapterAssembly();
    registerVoiceAdapters(assembly.adapters);
    metadata.writes.length = 0;
    network.requests.length = 0;
  });

  afterEach(async () => {
    resetVoiceAdapterRegistryForTests();
    await assembly?.dispose();
    await connection?.dispose();
    clearVoiceAgentRecoveryReplaySource('__voice_agent__');
  });
  afterAll(() => network.dispose());

  function expectCarrier(id: string, rootId?: string) {
    expect(metadata.writes).toContain(id);
    expect(readVoiceConversationScopeMetadata(readVoiceSessionOwnerMetadataFromState(storage.getState(), id)))
      .toEqual(rootId ? { kind: 'session_root', sessionRootId: rootId } : { kind: 'voice_home' });
    expect(network.requests.some(request => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
  }

  it('does not create a generic shadow session for direct-media realtime providers', async () => {
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      controlSessionId: '__voice_agent__', requestedTargetSessionId: 's1', settings: {} })).toBeNull();
    expect(metadata.writes).toEqual([]);
    expect(network.requests).toEqual([]);
  });

  it.each([
    ['trims provider ids before resolving local conversation bindings', ' local_conversation '],
    ['uses voice home and native transcript mode when no target session exists', 'local_conversation'],
  ])('%s', async (_title, providerId) => {
    expect(await ensureVoiceConversationBindingResolution({ providerId, controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null, settings: localSettings() })).toEqual({
      conversationSessionId: 'voice-home', conversationSessionAddress: address('voice-home'),
      controlSessionId: '__voice_agent__', transcriptMode: 'native_session', targetSessionAddress: null,
    });
    expectCarrier('voice-home');
  });

  it('binds local daemon agent sessions to the target session root', async () => {
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1', settings: localSettings() })).toEqual({
      conversationSessionId: 'voice-root-s1', conversationSessionAddress: address('voice-root-s1'),
      controlSessionId: '__voice_agent__', transcriptMode: 'native_session', targetSessionAddress: address('s1'),
    });
    expectCarrier('voice-root-s1', 's1');
    expect(metadata.writes).not.toContain('voice-home');
  });

  it.each(['voice-home', 'voice-root-s1'])('continues the exact synced carrier %s instead of making a carrier of it', async (conversationSessionId) => {
    const settings = localSettings();
    const resolution = await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation',
      controlSessionId: '__voice_agent__', requestedTargetSessionId: conversationSessionId,
      requestedTargetServerId: connection.home.id, settings });
    expect(resolution).toEqual({ controlSessionId: '__voice_agent__', conversationSessionId,
      conversationSessionAddress: address(conversationSessionId), transcriptMode: 'native_session',
      targetSessionAddress: conversationSessionId === 'voice-home' ? null : address('s1') });
    expect(readVoiceConversationScopeMetadata(readVoiceSessionOwnerMetadataFromState(storage.getState(), conversationSessionId)))
      .toEqual(conversationSessionId === 'voice-home' ? { kind: 'voice_home' } : { kind: 'session_root', sessionRootId: 's1' });
    expect(network.requests.some(request => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
  });

  it('hydrates an explicitly addressed conversation before deciding carrier reuse', async () => {
    // The Home owns this carrier; the new client has not opened/hydrated it yet.
    const detail = metadata.handle(new URL('/v2/sessions/voice-root-s1', connection.home.serverUrl));
    expect(detail?.status).toBe(200);
    storage.setState(current => ({ sessions: Object.fromEntries(Object.entries(current.sessions)
      .filter(([id]) => id !== 'voice-root-s1')), sessionListRowsByServerId: {} }));
    expect(readVoiceSessionOwnerMetadataFromState(storage.getState(), address('voice-root-s1'))).toBeNull();
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 'voice-root-s1', requestedTargetServerId: connection.home.id, settings: localSettings() }))
      .toMatchObject({ conversationSessionId: 'voice-root-s1', targetSessionAddress: address('s1') });
    expect(network.requests.some(request => request.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
  });

  it('keeps explicit continuation ahead of the voice-home preference and preserves its cleared coding target', async () => {
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const conversationSessionAddress = address('voice-root-s1');
    storage.setState(current => ({ sessions: { ...current.sessions, 'voice-root-s1': {
      ...current.sessions['voice-root-s1']!, metadata: writeVoiceConversationBindingMetadata(current.sessions['voice-root-s1']!.metadata!, {
        adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
        conversationSessionId: conversationSessionAddress.sessionId, conversationSessionAddress,
        targetSessionAddress: null, transcriptMode: 'native_session', updatedAt: 1,
      }),
    } } }));
    metadata.replaceSession('voice-root-s1');
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 'voice-root-s1', requestedTargetServerId: connection.home.id, settings: localSettings(true) }))
      .toMatchObject({ conversationSessionId: 'voice-root-s1', targetSessionAddress: null });
  });

  it('uses voice home when stayInVoiceHome is enabled even with a target', async () => {
    const settings = localSettings(true);
    storage.setState({ settings });
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1', settings })).toEqual({
      conversationSessionId: 'voice-home', conversationSessionAddress: address('voice-home'),
      controlSessionId: '__voice_agent__', transcriptMode: 'native_session', targetSessionAddress: address('s1'),
    });
    expectCarrier('voice-home');
    expect(metadata.writes).not.toContain('voice-root-s1');
  });

  it('recovers a global voice-home binding by switching machines and preserving replay context', async () => {
    machineRows = [createPlainMachineRowFixture({ id: 'm_old', accountId: 'account-binding' }),
      createPlainMachineRowFixture({ id: 'm_new', accountId: 'account-binding' })];
    machineRows[0] = { ...machineRows[0]!, active: false, activeAt: 0 };
    await sync.refreshMachines();
    const old = { ...carrier('sys_voice_old', undefined, 'm_old', 10), active: false };
    storage.setState({ sessions: { sys_voice_old: old,
      'voice-home-new-machine': carrier('voice-home-new-machine', undefined, 'm_new') } });
    voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
      conversationSessionId: 'sys_voice_old', conversationSessionAddress: address('sys_voice_old'),
      transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: 10 });
    persistVoiceAutoTargetMachineId('m_old', storage.getState().settingsScope);
    const resolutionPromise = ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null, settings: localSettings() });
    await waitForTestEvent(subscribeNativeAlert, () => expect(nativeAlertCalls.length).toBe(1));
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('m_old');
    expect(readVoiceAgentRecoveryReplaySource('__voice_agent__')).toBeNull();
    expect(nativeAlertCalls[0]?.[3]?.cancelable).toBe(false);
    const confirmSwitch = nativeAlertCalls[0]?.[2]?.[1]?.onPress;
    if (!confirmSwitch) throw new Error('Native switch confirmation was not presented');
    confirmSwitch();

    await waitForTestEvent(subscribeNativeAlert, () => expect(nativeAlertCalls.length).toBe(2));
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('m_old');
    expect(readVoiceAgentRecoveryReplaySource('__voice_agent__')).toBeNull();
    expect(nativeAlertCalls[1]?.[3]?.cancelable).toBe(false);
    const confirmReplay = nativeAlertCalls[1]?.[2]?.[1]?.onPress;
    if (!confirmReplay) throw new Error('Native replay confirmation was not presented');
    confirmReplay();

    const resolution = await resolutionPromise;
    expect(readVoiceAutoTargetMachineId(storage.getState())).toBe('m_new');
    expect(readVoiceAgentRecoveryReplaySource('__voice_agent__')).toBe('sys_voice_old');
    expect(resolution).toEqual({ conversationSessionId: 'voice-home-new-machine', conversationSessionAddress: address('voice-home-new-machine'),
      controlSessionId: '__voice_agent__', transcriptMode: 'native_session', targetSessionAddress: null });
    expectCarrier('voice-home-new-machine');
  });

  it('keeps Provider-backed Chat on the daemon-owned native transcript binding', async () => {
    const settings = settingsParse({ voice: { providers: { local_conversation: { schemaVersion: 1, config: {
      conversationMode: 'agent', agent: { agentSource: 'agent', agentId: 'opencode', providerChat: {
        status: 'configured', chat: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: 'provider-chat', modelId: 'chat' },
        commit: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: 'provider-chat', modelId: 'commit' },
      } },
    } } } } });
    storage.setState({ settings });
    storage.getState().applySessions(['s2', 'voice-root-s2'].map(id => {
      const session = storage.getState().sessions[id]!;
      return { ...session, metadata: { ...session.metadata!, flavor: 'opencode',
        // Fixed-Agent carriers record the same explicit native default that
        // R41's immutable recipe matcher receives from canonical creation.
        ...(id === 'voice-root-s2' ? { connectedServices: { v: 2 as const, bindingsByServiceId: {} } } : {}),
      } };
    }));
    metadata.replaceSession('s2');
    metadata.replaceSession('voice-root-s2');
    const resolution = await ensureVoiceConversationBindingResolution({ providerId: 'local_conversation', controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's2', settings });
    expect(resolution?.transcriptMode).toBe('native_session');
    expect(resolution?.conversationSessionAddress).toEqual(address('voice-root-s2'));
    expectCarrier('voice-root-s2', 's2');
  });

  it('resolves a registry-driven provider through its transcript-mode capability', async () => {
    registerVoiceAdapters([...assembly.adapters, { ...assembly.adapters[0]!, id: 'custom_provider', resolveConversationBinding: undefined,
      resolveBindingTranscriptMode: () => 'synthetic' }]);
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'custom_provider', controlSessionId: 's9',
      requestedTargetSessionId: 's9', settings: {} })).toEqual({ conversationSessionId: 'voice-root-s9',
      conversationSessionAddress: address('voice-root-s9'), controlSessionId: 's9', transcriptMode: 'synthetic', targetSessionAddress: address('s9') });
    expectCarrier('voice-root-s9', 's9');
  });

  it('delegates an exact provider-owned binding without creating a shadow session', async () => {
    registerVoiceAdapters([...assembly.adapters, { ...assembly.adapters[0]!, id: 'native_session_provider',
      resolveConversationBinding: async ({ controlSessionId, requestedTargetSessionAddress }) => ({
        conversationSessionAddress: address(controlSessionId), transcriptMode: 'native_session', targetSessionAddress: requestedTargetSessionAddress,
      }) }]);
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'native_session_provider', controlSessionId: 'codex-session-1',
      requestedTargetSessionId: 'codex-session-1', settings: {} })).toEqual({ conversationSessionId: 'codex-session-1',
      conversationSessionAddress: address('codex-session-1'), controlSessionId: 'codex-session-1', transcriptMode: 'native_session', targetSessionAddress: address('codex-session-1') });
    expect(metadata.writes).toEqual([]);
    expect(network.requests).toEqual([]);
  });

  it('returns null for providers without a hidden voice conversation session', async () => {
    expect(await ensureVoiceConversationBindingResolution({ providerId: 'local_direct', controlSessionId: 's1',
      requestedTargetSessionId: 's1', settings: {} })).toBeNull();
    expect(metadata.writes).toEqual([]);
    expect(network.requests).toEqual([]);
  });
});
