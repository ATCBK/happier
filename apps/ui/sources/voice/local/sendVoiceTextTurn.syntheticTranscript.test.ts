import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { serveAccountHomes, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { readCanonicalVoiceTranscriptSnapshot } from '@/voice/transcript/voiceConversationTranscript';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema, ExecutionRunUserTranscriptCommitRequestSchema,
  ExecutionRunUserTranscriptCommitResponseSchema, type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';

const conversationModeState: { current: 'agent' | 'direct_session' } = { current: 'agent' };
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
let retainedAgent: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
installDisconnectedServerSocketBoundary(socket => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected canonical Voice RPC');
    const method = payload.method.slice(payload.method.indexOf(':') + 1);
    return { ok: true, result: await retainedAgent.dispatch(method, payload.params) };
  });
});

await loadSyncSingletonForTests();
const restoreActionLoader = await installRealActionExecutorModuleLoader();
afterAll(() => restoreActionLoader());
const { storage } = await import('@/sync/domains/state/storage');
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const sessionMetadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
let account: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
const events: string[] = [];
type TurnReply = { assistantText: string; actions: VoiceAssistantAction[] };
let turnReplies: (index: number) => TurnReply = () => ({ assistantText: 'Done.', actions: [] });
let turnIndex = 0;
let rejectStart = false;
const repliesByStream = new Map<string, TurnReply>();
async function answerVoiceAgentRpc(method: string, input: unknown): Promise<unknown> {
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1) {
    ExecutionRunUserTranscriptCommitRequestSchema.parse(input);
    return ExecutionRunUserTranscriptCommitResponseSchema.parse({ ok: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
    const request = ExecutionRunTurnStreamStartV2RequestSchema.parse(input);
    const streamId = 'transcript-turn-' + turnIndex;
    const admission = pendingWrites()[0]?.body;
    if (!admission || typeof admission !== 'object' || !('localId' in admission)) throw new Error('Dispatch preceded durable admission');
    if (turnIndex === 0) events.push('dispatch:' + admission.localId);
    if (rejectStart) return { error: 'send_failed' };
    if (turnIndex === 0) {
      const admitted = pendingRecords()[0];
      expect(admitted?.content.type).toBe('text');
      if (admitted?.content.type === 'text') expect(request.displayMessage ?? request.message).toBe(admitted.content.text);
    }
    repliesByStream.set(streamId, turnReplies(turnIndex++));
    return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
    const request = ExecutionRunTurnStreamReadRequestSchema.parse(input);
    const reply = repliesByStream.get(request.streamId);
    if (!reply) throw new Error('Unknown transcript stream');
    const outputs: ExecutionRunTurnStreamEvent[] = reply.actions.map((action, index) => ({
      t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: request.streamId, seq: index,
        effectId: `${request.streamId}:effect:${index}`, action },
    }));
    outputs.push({ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: request.streamId,
      seq: outputs.length, text: reply.assistantText } });
    return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: request.streamId,
      events: request.cursor === 0 ? outputs : [], nextCursor: outputs.length, done: true });
  }
  if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
  throw new Error('Unexpected Voice daemon method: ' + method);
}
function pendingWrites(sessionId = 'carrier-s1') {
  return account.requests.filter(request => request.method === 'POST' && request.path === `/v2/sessions/${sessionId}/pending`);
}
function pendingRecords(sessionId = 'carrier-s1') {
  return pendingWrites(sessionId).map(request => {
    if (!request.body || typeof request.body !== 'object' || !('content' in request.body)) throw new Error('Expected canonical pending content');
    const content = StrictSessionStoredMessageContentEnvelopeSchema.parse(request.body.content);
    if (content.t !== 'plain') throw new Error('Expected plain Account content');
    return RawRecordSchema.parse(content.v);
  });
}
function expectNoSyntheticTranscript() {
  expect(readCanonicalVoiceTranscriptSnapshot('carrier-s1')).toEqual([]);
  expect(readStoredSessionMessages(storage.getState(), 'carrier-s1')).toEqual([]);
}

function buildAccountSettings() {
  return settingsParse({
    ...settingsDefaults,
    ...normalizeVoiceSettingsLocalDelta({
    experiments: true,
    featureToggles: {
      ...settingsDefaults.featureToggles,
      voice: true, 'voice.agent': true, 'execution.runs': true,
    },
    voice: {
      ...settingsDefaults.voice,
      providerId: 'local_conversation',
      executionMachine: { mode: 'fixed', machineId: 'machine-1' },
      providers: {
        ...settingsDefaults.voice.providers,
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: conversationModeState.current,
            agent: { agentSource: 'session', prewarmOnConnect: false },
            tts: { autoSpeakReplies: false },
            streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 120 },
          },
        },
      },
    },
    }),
  });
}

async function loadSendVoiceTextTurnWithProductionBinding() {
  const [
    { createLocalConversationVoiceAdapter },
    { registerVoiceAdapters, resetVoiceAdapterRegistryForTests },
    { voiceSessionBindingManager },
    { voiceSessionBindingStore },
    localVoiceTextTurn,
  ] = await Promise.all([
    import('@/voice/adapters/localConversation/localConversationAdapter'),
    import('@/voice/session/voiceAdapterRegistry'),
    import('@/voice/binding/voiceConversationBindingRuntime'),
    import('@/voice/binding/voiceConversationBindingStore'),
    import('./sendVoiceTextTurn'),
  ]);

  resetVoiceAdapterRegistryForTests();
  registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
  for (const binding of voiceSessionBindingManager.list()) {
    voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
  }
  const binding = await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    requestedTargetSessionId: 's1',
  });
  expect(binding).toMatchObject({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId: 'carrier-s1',
    transcriptMode: 'native_session',
    targetSessionAddress: { serverId: account.homes.voice!.id, sessionId: 's1' },
  });
  await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
  expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
  return localVoiceTextTurn;
}

describe('sendVoiceTextTurn native-session transcript ownership', () => {
  beforeEach(async () => {
    conversationModeState.current = 'agent';
    events.length = 0;
    turnIndex = 0;
    rejectStart = false;
    turnReplies = () => ({ assistantText: 'I found Claude and Codex.', actions: [] });
    repliesByStream.clear();
    retainedAgent = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: answerVoiceAgentRpc });
    account = await serveAccountHomes({ homes: [
      { key: 'other', serverUrl: 'https://transcript-other.test', accountId: 'account-b' },
      { key: 'voice', serverUrl: 'https://transcript-voice.test', accountId: 'account-a', currentAccount: true, settings: buildAccountSettings() },
    ], route: request => {
      if (request.path === '/v1/account/profile') return request.accountId
        ? Response.json({ ...profileDefaults, id: request.accountId })
        : Response.json({}, { status: 401 });
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
        features: { voice: { enabled: true, agent: { enabled: true } }, execution: { runs: { enabled: true } },
          machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } } },
        capabilities: { session: { pendingInput: { protocolVersion: 1 } },
          machines: { liveStream: { serverRouted: { caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null } } } },
      }));
      if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      // This Home has no target Session: do not serve the active Home's seed
      // through another Home's real scoped fetch.
      if (request.home === 'other') return undefined;
      const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
      if (request.path === '/v1/machines') return Response.json([machine]);
      if (request.path === '/v1/machines/machine-1') return Response.json({ machine });
      if (/^\/v2\/sessions\/[^/]+\/pending$/.test(request.path)) {
        if (request.method !== 'POST') return Response.json({ pending: [], discarded: [], pendingVersion: 0 });
        const body = request.body;
        if (!body || typeof body !== 'object' || !('localId' in body) || !('requestedAction' in body)) throw new Error('Expected canonical pending producer');
        events.push(`enqueue:${body.localId}`);
        // The canonical enqueue producer omits deliveryMode for ordinary
        // queued Actions; only explicit external handoff includes that field.
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId,
          deliveryStatus: { status: 'deliveryMode' in body && body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued' } } });
      }
      const handled = /\/pending\/([^/]+)\/delivery\/handled$/.exec(request.path);
      if (request.method === 'POST' && handled) { events.push(`settle:${decodeURIComponent(handled[1]!)}`); return Response.json({}); }
      if (/^\/v1\/sessions\/[^/]+\/messages$/.test(request.path)) return Response.json({ messages: [], hasMore: false });
      return sessionMetadata.handle(request.url, { method: request.method,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) }) ?? undefined;
    } });
    disconnect = await account.restoreActiveConnection();
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    const serverId = account.homes.voice!.id;
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
    const target = createSessionFixture({ id: 's1', serverId, active: true, presence: 'online', pendingVersion: 0, pendingCount: 0, metadata: {
      machineId: machine.id, path: '/workspace/s1', host: 'voice.test', flavor: 'claude',
      agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
    } });
    const carrier = createSessionFixture({ id: 'carrier-s1', serverId, active: true, presence: 'online', pendingVersion: 0, pendingCount: 0,
      metadata: writeVoiceConversationScopeMetadata({ ...target.metadata!,
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
      }, { kind: 'session_root', sessionRootId: target.id }) });
    storage.setState({ sessions: { s1: target, 'carrier-s1': carrier }, machines: { [machine.id]: machine },
      machineListByServerId: { [serverId]: [machine] }, sessionMessages: {},
    });
    sessionMetadata.replaceSession(target.id);
    sessionMetadata.replaceSession(carrier.id);
    account.requests.length = 0;
    voiceConversationRuntimeMachine.reset();
  });

  afterEach(async () => { await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID); await disconnect?.(); disconnect = undefined; await account?.dispose(); });

  it('submits direct coding-session voice turns through durable immediate delivery', async () => {
    conversationModeState.current = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: buildAccountSettings(),
      userText: 'send this directly',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toHaveLength(1);
    expect(pendingWrites('s1')[0]?.body).toMatchObject({ requestedAction: { v: 1, kind: 'send_now' } });
    expect(pendingRecords('s1')[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'send this directly' } });
    expect(pendingWrites()).toEqual([]);
  });

  it('does not admit a direct coding-session voice turn after cancellation', async () => {
    conversationModeState.current = 'direct_session';
    const controller = new AbortController();
    controller.abort();
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await expect(sendVoiceTextTurn({
      sessionId: 's1',
      settings: buildAccountSettings(),
      userText: 'cancelled before admission',
      signal: controller.signal,
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(pendingWrites('s1')).toEqual([]);
  });

  it('does not duplicate daemon-owned local agent turns in the UI transcript projector', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'list the backends',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expectNoSyntheticTranscript();
    expect(pendingRecords()).toHaveLength(1);
  });

  it('durably enqueues speech input before one local-agent dispatch', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'from microphone',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    const body = pendingWrites()[0]?.body;
    expect(body).toMatchObject({ localId: expect.any(String) });
    if (!body || typeof body !== 'object' || !('localId' in body)) throw new Error('Missing durable admission');
    const localId = body.localId;
    expect(account.requests.filter(request => request.method === 'POST' && /\/delivery\/handled$/.test(request.path))).toHaveLength(1);
    expect(turnIndex).toBe(1);
    expect(events).toEqual([`enqueue:${localId}`, `dispatch:${localId}`, `settle:${localId}`]);
  });

  it('trims the control session id while preserving daemon transcript ownership', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    await sendVoiceTextTurn({
      sessionId: ` ${VOICE_AGENT_GLOBAL_SESSION_ID} `,
      settings: buildAccountSettings(),
      userText: 'list the backends',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expectNoSyntheticTranscript();
    expect(pendingRecords()).toHaveLength(1);
  });

  it('normalizes sendSessionMessage preambles without creating synthetic tool transcript rows', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    turnReplies = index => index === 0
      ? { assistantText: 'I will send that now.', actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }] }
      : { assistantText: 'Done.', actions: [] };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toHaveLength(1);
    expect(pendingWrites('s1')[0]).toMatchObject({ home: 'voice', accountId: 'account-a',
      body: { requestedAction: { v: 1, kind: 'steer_if_active' } } });
    expect(pendingRecords('s1')[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } });
    expectNoSyntheticTranscript();
  });

  it('records a bounded-limit status without persisting or executing the terminal action-bearing response', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    const { voiceOutputStatusStore } = await import('@/voice/runtime/outputStatus/voiceOutputStatusStore');
    const { voiceTextTurnPendingPort } = await import('@/voice/binding/sendVoiceSessionComposerText');
    turnReplies = index => ({ assistantText: index === 3 ? 'Done. I sent it again.' : 'Round ' + (index + 1),
      actions: [{ t: 'sendSessionMessage', args: { message: 'hello-' + (index + 1) } }] });

    const admitted = await voiceTextTurnPendingPort.enqueuePendingMessage({
      conversationSessionId: 'carrier-s1', text: 'keep sending', localId: 'bounded-tool-input',
    });
    expect(admitted.externalHandoffClaimed).toBe(true);
    // Exercise the canonical post-admission dispatch directly. The outer
    // custody owner deliberately settles accepted input even when its later
    // response fails; this keeps a bounded-loop failure observable here.
    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'keep sending',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
      durableDispatch: { localId: admitted.localId, deliveryCommand: 'interrupt_and_send' },
      onUserTranscriptAccepted: () => voiceTextTurnPendingPort.markPendingDeliveryHandled({
        conversationSessionId: 'carrier-s1', localId: admitted.localId,
      }),
    });

    expect(turnIndex, JSON.stringify({
      daemonMethods: retainedAgent.requests.map(request => request.method),
      admittedToolMessages: pendingRecords('s1').map(record => record.content),
      runtime: voiceConversationRuntimeMachine.getSnapshot(),
    })).toBe(4);
    expect(pendingRecords('s1').map(record => record.content)).toEqual([
      { type: 'text', text: 'hello-1' }, { type: 'text', text: 'hello-2' }, { type: 'text', text: 'hello-3' },
    ]);
    expectNoSyntheticTranscript();
    expect(voiceOutputStatusStore.readForSession(VOICE_AGENT_GLOBAL_SESSION_ID)).toMatchObject({
      statusId: 'tool_round_limit_reached',
      text: 'Tool round limit reached before the requested actions could run.',
    });
    voiceOutputStatusStore.clear({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      turnId: 'local_voice_agent:tool_round_limit',
    });
  });

  it('resolves implicit tool session ids from the bound target session', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();

    turnReplies = index => index === 0
      ? { assistantText: 'I will send that now.', actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }] }
      : { assistantText: 'Done.', actions: [] };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toHaveLength(1);
    expect(pendingWrites('s1')[0]).toMatchObject({ home: 'voice', accountId: 'account-a',
      body: { requestedAction: { v: 1, kind: 'steer_if_active' } } });
    expect(pendingRecords('s1')[0]).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello' } });
  });

  it('does not send an implicit tool action to the active Home when the bound target is on another Home', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
    await voiceSessionBindingManager.syncTargetSession({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      targetSessionAddress: { serverId: account.homes.other!.id, sessionId: 's1' },
    });

    turnReplies = index => index === 0
      ? { assistantText: 'I will send that now.', actions: [{ t: 'sendSessionMessage', args: { message: 'hello on Home B' } }] }
      : { assistantText: 'Done.', actions: [] };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'send hello on the bound target',
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });

    expect(pendingWrites('s1')).toEqual([]);
    expect(account.requests.filter(request => request.home === 'other' && request.method === 'POST')).toEqual([]);
  });

  it('rethrows agent-mode send failures after recording the error state', async () => {
    const { sendVoiceTextTurn } = await loadSendVoiceTextTurnWithProductionBinding();
    rejectStart = true;

    await expect(
      sendVoiceTextTurn({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        settings: buildAccountSettings(),
        userText: 'send hello',
        playbackController: createVoicePlaybackController(),
        voiceAgentSessions,
      }),
    ).rejects.toThrow('voice_turn_dispatch_ambiguous');
  });
});
