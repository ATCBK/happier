import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import type { AgentRuntime, AgentSessionRuntimeEvent, AgentSessionSendRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol';
import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import {
  SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
  SessionTranscriptObservationCapabilityAckSchema, SessionTranscriptObservationCapabilityRequestSchema,
  SessionTranscriptObservationInputSchema, SessionTranscriptObservationAckV1Schema,
} from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import { VoiceAgentManager } from '../../../voice/agent/VoiceAgentManager';
import { createVoiceSessionRuntimeThroughNativeFactory } from './testkit/nativeSessionContext';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTurnMutationAppliedSocketAck } from '@/testkit/backends/apiSessionSocketHarness';
import * as executionRunRegistration from '@/rpc/handlers/executionRuns';
import {
  parseRuntimeSessionClientDurableMutation, resolveSessionClientDurableMutationOutboxPath,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';
import type { PersistedTranscriptMessageAppendMutationV1, PersistedVoiceAgentTranscriptTurnMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import {
  cancelVoiceAgentTurnStream, commitVoiceAgentUserTranscript, readVoiceAgentTurnStream, startVoiceAgentTurnStream,
} from './voiceAgentTurnStreams';
import { enqueueExecutionRunMarkerWrite, writeExecutionRunActivityMarker } from './activityMarkers';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '../../../executionRuns/controllers/types';

// Native ESM namespaces are immutable. This configurable OS-boundary view still
// delegates every operation to Node; the two scoped fault/observation spies below
// leave the actual atomic writer and durable journal implementation untouched.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

type ProviderEvent<T = AgentSessionRuntimeEvent> = T extends AgentSessionRuntimeEvent
  ? Omit<T, 'sessionId' | 'sequence' | 'emittedAtMs'> : never;

function createVoiceAgentController(voiceAgentId: string, persistenceMode: 'persistent' | 'ephemeral'): ExecutionRunVoiceAgentController {
  return {
    kind: 'voice_agent', controllerOccurrenceId: 'voice-agent-controller-1', voiceAgentId,
    cancelled: false, lastMarkerWriteAtMs: 0, terminalPromise: Promise.resolve(), resolveTerminal() {},
    transcript: { persistenceMode, epoch: 7 }, externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
    pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(), readInFlightByExternalStreamId: new Map(),
  };
}

/** Actual Session registration supplies the writer; native factory/Manager own admission and turns.
 * Only Socket.IO receipts, Agent SDK events, and the exact Session journal's OS writes are scripted. */
async function createTurnStreamFixture(options: Readonly<{
  persistenceMode?: 'persistent' | 'ephemeral';
  reply?: (prompt: string, index: number) => string;
  onSend?: (request: AgentSessionSendRequest, publish: (event: ProviderEvent) => void) => void;
}> = {}) {
  const sessionId = `voice-turnstream-${randomUUID()}`;
  const machineId = 'voice-fixture-machine';
  const credentials = { token: 'voice-turnstream-token', encryption: null };
  const sessionSnapshot = createPlainSessionFixture({ id: sessionId });
  const sessionRecord = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify(sessionSnapshot.metadata) });
  const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}` || path === `/v1/sessions/${sessionId}`) return { status: 200, data: { session: sessionRecord } };
    if (path === `/v1/sessions/${sessionId}/messages`) return { status: 200, data: { messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    return { status: 404, data: {} };
  });
  const home = createSessionRuntimeActivityHomeStub({ machineId });
  const observations: ReturnType<typeof SessionTranscriptObservationInputSchema.parse>[] = [];
  const requests: AgentSessionSendRequest[] = [];
  const order: string[] = [];
  const journalTurns = new Map<string, PersistedVoiceAgentTranscriptTurnMutationV1>();
  const journalMessages = new Map<string, PersistedTranscriptMessageAppendMutationV1>();
  const journalPath = resolveSessionClientDurableMutationOutboxPath(sessionId);
  let storage: 'normal' | 'held' | 'failed' = 'normal';
  let announceWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const readJournalMutations = (data: unknown) => {
    const value: unknown = typeof data === 'string' ? JSON.parse(data) : null;
    if (!value || typeof value !== 'object' || !('mutations' in value) || !Array.isArray(value.mutations)) return [];
    return value.mutations.flatMap((mutation: unknown) => parseRuntimeSessionClientDurableMutation(mutation, sessionId).mutations);
  };
  const writeFile = fs.writeFile;
  const rename = fs.rename;
  const diskWrite = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, opts) => {
    if (typeof path === 'string' && dirname(path) === dirname(journalPath) && typeof data === 'string') {
      const turns = readJournalMutations(data).flatMap((queued) => queued.kind === 'voice_agent_transcript_turn' ? [queued.payload] : []);
      if (turns.some((turn) => !journalTurns.has(turn.turnId)) && storage !== 'normal') {
        announceWrite();
        if (storage === 'held') await writeReleased;
        else throw Object.assign(new Error('Voice transcript disk is full'), { code: 'ENOSPC' });
      }
    }
    await writeFile(path, data, opts);
  });
  // Observe committed journal bytes after the real atomic rename; no journal decisions are copied.
  const diskRename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const mutations = String(to) === journalPath ? readJournalMutations(await fs.readFile(from, 'utf8')) : [];
    await rename(from, to);
    for (const queued of mutations) {
      if (queued.kind === 'voice_agent_transcript_turn') journalTurns.set(queued.payload.turnId, queued.payload);
      if (queued.kind === 'transcript_message_append') {
        if (!journalMessages.has(queued.payload.localId) && queued.payload.messageRole === 'user') order.push(`persist:${queued.payload.localId}`);
        journalMessages.set(queued.payload.localId, queued.payload);
      }
    }
  });
  let seq = 0;
  const socket = createApiSessionSocketStub({
    connected: true,
    emit(event, args) { if (event === 'ping' && typeof args[0] === 'function') args[0](); },
    emitWithAck(event, payload, currentSocket) {
      if ((event === 'update-metadata' || event === 'update-state') && payload && typeof payload === 'object'
        && 'expectedVersion' in payload && typeof payload.expectedVersion === 'number') {
        return { result: 'success', version: payload.expectedVersion + 1,
          ...(event === 'update-metadata' && 'metadata' in payload ? { metadata: payload.metadata } : {}),
          ...(event === 'update-state' && 'agentState' in payload ? { agentState: payload.agentState } : {}),
        };
      }
      if (event === 'session-turn-mutation') return createSessionTurnMutationAppliedSocketAck(SessionTurnMutationV1Schema.parse(payload));
      if (event === 'message' && payload && typeof payload === 'object' && 'localId' in payload
        && typeof payload.localId === 'string' && 'message' in payload) {
        const content = SessionStoredMessageContentSchema.parse(payload.message);
        const messageSeq = ++seq;
        currentSocket.trigger('update', { id: `echo-${messageSeq}`, createdAt: Date.now(), body: {
          t: 'new-message', sid: sessionId, message: { id: `message-${messageSeq}`, seq: messageSeq,
            localId: payload.localId, content, ...('messageRole' in payload ? { messageRole: payload.messageRole } : {}),
          },
        } });
        return MessageAckResponseSchema.parse({ ok: true, id: `message-${messageSeq}`, seq: messageSeq, localId: payload.localId });
      }
      if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
        SessionTranscriptObservationCapabilityRequestSchema.parse(payload);
        return SessionTranscriptObservationCapabilityAckSchema.parse({ ok: true, capability: 'session-transcript-observation-v1' });
      }
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        const observation = SessionTranscriptObservationInputSchema.parse(payload);
        observations.push(observation);
        const messageSeq = ++seq;
        if (observation.messageRole === 'user') {
          currentSocket.trigger('update', { id: `echo-${messageSeq}`, createdAt: Date.now(), body: { t: 'new-message', sid: sessionId, message: {
            id: `message-${messageSeq}`, seq: messageSeq, localId: observation.localId,
            messageRole: 'user', content: observation.content,
          } } });
        }
        return SessionTranscriptObservationAckV1Schema.parse({
          ok: true, status: 'observed', id: `message-${messageSeq}`, seq: messageSeq,
          localId: observation.localId, didWrite: true, ingestedAt: 200,
        });
      }
      const activity = home.answer(event, payload);
      if (activity) return activity;
      const message = payload && typeof payload === 'object' && 'localId' in payload ? payload : null;
      return { ok: true, id: `message-${++seq}`, seq, localId: message?.localId };
    },
  });
  // Observation only: the real registration body, handlers, and writer remain installed.
  const registration = vi.spyOn(executionRunRegistration, 'registerExecutionRunHandlers');
  let session: ApiSessionClient | undefined;
  let manager: VoiceAgentManager | undefined;
  try {
    session = createTestApiSessionClient(ApiSessionClient, credentials.token, sessionSnapshot, {
      metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials }, localMachineId: machineId,
      transport: {
        serverId: 'voice-turnstream-home', serverUrl: 'https://voice-turnstream.example.test',
        // Incumbent structural Socket.IO boundary; real Session transport and supervisor remain beneath it.
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
      },
    });
    const actualSession = session;
    await vi.waitFor(() => expect(registration.mock.calls.find(([, context]) => context.sessionId === sessionId)?.[1].transcriptWriter).toBeDefined());
    const writer = registration.mock.calls.find(([, context]) => context.sessionId === sessionId)![1].transcriptWriter!;
    registration.mockRestore();
    let openCount = 0;
    const sdk: AgentRuntime = { sessions: { async open() {
      openCount += 1;
      const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
      let sequence = 0;
      const publish = (event: ProviderEvent) => {
        const value = { ...event, sessionId, sequence: sequence++, emittedAtMs: 1 };
        for (const listener of listeners) listener(value);
      };
      return {
        watch(listener) {
          listeners.add(listener);
          listener({ kind: 'provider-session-id', sessionId, providerSessionId: 'voice-provider-session', sequence: sequence++, emittedAtMs: 1 });
          return { dispose() { listeners.delete(listener); } };
        },
        async send(request) {
          requests.push(request);
          order.push('provider');
          const turnId = request.delivery.turnId;
          publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
          publish({ kind: 'turn-start', turnId, startedBy: 'host' });
          if (options.onSend) options.onSend(request, publish);
          else {
            publish({ kind: 'message-delta', turnId, channel: 'assistant', text: options.reply?.(request.input.text, requests.length) ?? 'assistant reply' });
            publish({ kind: 'turn-complete', turnId });
          }
          return { status: 'admitted' as const };
        },
        async cancel(request) {
          publish({ kind: 'turn-cancelled', turnId: request.turnId, cause: 'user' });
          return { status: 'requested' as const, turnId: request.turnId };
        },
        async dispose() { listeners.clear(); },
      };
    } } };
    manager = new VoiceAgentManager({ createRuntime: () => createVoiceSessionRuntimeThroughNativeFactory({
      runtime: sdk, session: actualSession, modelId: 'chat-model', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
    }) });
    const actualManager = manager;
    const startedAgent = await actualManager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const ctrl = createVoiceAgentController(startedAgent.voiceAgentId, options.persistenceMode ?? 'persistent');
    const run: ExecutionRunState = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', sessionId, depth: 0,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude', instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'long_lived', startedAtMs: 1, status: 'running', intent: 'voice_agent', ioMode: 'streaming',
    };
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunController>([['run_1', ctrl]]);
    const markerWriteChains = new Map<string, Promise<void>>();
    const writeActivityMarker = (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) =>
      writeExecutionRunActivityMarker({ runId, nowMs, opts, runs, controllers,
        enqueueMarkerWrite: (markerRunId, write) => enqueueExecutionRunMarkerWrite({ markerWriteChains, runId: markerRunId, write }),
      });
    const base = { runId: 'run_1', runs, controllers, voiceAgentManager: actualManager, transcriptWriter: writer };
    return {
      ...base, manager: actualManager, session: actualSession, ctrl, socket, requests, order, observations, journalTurns, journalMessages,
      getOpenCount: () => openCount, writeStarted, releaseWrite,
      setStorage: (value: typeof storage) => { storage = value; },
      start: (params: Parameters<typeof startVoiceAgentTurnStream>[0]['params']) => startVoiceAgentTurnStream({ ...base, params }),
      read: (streamId: string, params: Omit<Parameters<typeof readVoiceAgentTurnStream>[0]['params'], 'streamId'> = { cursor: 0 }) =>
        readVoiceAgentTurnStream({ ...base, params: { streamId, ...params }, writeActivityMarker, getNowMs: () => 123 }),
      cancel: (streamId: string) => cancelVoiceAgentTurnStream({ ...base, params: { streamId } }),
      async dispose() {
        storage = 'normal'; releaseWrite();
        try { await actualManager.dispose(); } finally {
          try { await actualSession.close(); } finally { diskWrite.mockRestore(); diskRename.mockRestore(); http.mockRestore(); }
        }
      },
    };
  } catch (error) {
    registration.mockRestore(); storage = 'normal'; releaseWrite();
    try { await manager?.dispose(); await session?.close(); } finally { diskWrite.mockRestore(); diskRename.mockRestore(); http.mockRestore(); }
    throw error;
  }
}

function requireStream(result: Awaited<ReturnType<typeof startVoiceAgentTurnStream>>) {
  if (!result.ok) throw new Error(result.error);
  return result.streamId;
}

async function awaitFinished(fixture: Awaited<ReturnType<typeof createTurnStreamFixture>>, streamId: string) {
  await vi.waitFor(() => {
    expect(fixture.journalTurns.has(streamId)).toBe(true);
    expect(fixture.manager.isTurnInFlight(fixture.ctrl.voiceAgentId)).toBe(false);
  });
}

describe('voiceAgentTurnStreams', () => {
  it('persists the display override for an explicit user-transcript commit and otherwise uses provider text', async () => {
    const fixture = await createTurnStreamFixture();
    try {
      await expect(commitVoiceAgentUserTranscript({ ...fixture, text: 'Provider-facing text', displayText: 'User-visible text', localId: 'local-display' })).resolves.toEqual({ ok: true });
      await expect(commitVoiceAgentUserTranscript({ ...fixture, text: 'Provider-only text', localId: 'local-provider' })).resolves.toEqual({ ok: true });
      expect([...fixture.journalMessages.values()].filter((row) => row.messageRole === 'user')).toMatchObject([
        { localId: 'local-display', content: { t: 'plain', v: { content: { type: 'text', text: 'User-visible text' }, meta: {
          happierProvenanceV1: { v: 1, kind: 'host', producer: 'executionRunVoice' },
        } } } },
        { localId: 'local-provider', content: { t: 'plain', v: { content: { type: 'text', text: 'Provider-only text' } } } },
      ]);
      expect(fixture.requests).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it('persists the exact v2 outer local id before starting the provider', async () => {
    const fixture = await createTurnStreamFixture();
    try {
      const streamId = requireStream(await fixture.start({ message: 'provider payload', displayMessage: 'Outer prompt', userTranscript: { mode: 'persist', localId: ' opaque-local-id ' } }));
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      expect(fixture.order.slice(0, 2)).toEqual(['persist: opaque-local-id ', 'provider']);
      expect(fixture.requests[0].inputIds).toEqual([' opaque-local-id ']);
      expect(fixture.journalMessages.get(' opaque-local-id ')).toMatchObject({ localId: ' opaque-local-id ', content: { t: 'plain', v: { content: { text: 'Outer prompt' } } } });
      await vi.waitFor(async () => expect(await fixture.read(streamId)).toMatchObject({ ok: true, done: true }));
    } finally { await fixture.dispose(); }
  });

  it('rejects v2 persist before provider effects without a persistent committed writer', async () => {
    const fixture = await createTurnStreamFixture({ persistenceMode: 'ephemeral' });
    try {
      await expect(startVoiceAgentTurnStream({ ...fixture, transcriptWriter: null, params: { message: 'Outer prompt', userTranscript: { mode: 'persist', localId: 'opaque-local-id' } } })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      expect(fixture.requests).toEqual([]);
      expect(fixture.observations).toEqual([]);
      expect(fixture.journalMessages.size).toBe(0);
      expect(fixture.ctrl.internalStreamIdByExternal.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('allows explicit suppress without any transcript writer', async () => {
    const fixture = await createTurnStreamFixture({ persistenceMode: 'ephemeral' });
    try {
      const streamId = requireStream(await startVoiceAgentTurnStream({ ...fixture, transcriptWriter: null, params: { message: 'tool follow-up', userTranscript: { mode: 'suppress' } } }));
      await vi.waitFor(async () => expect(await fixture.read(streamId)).toMatchObject({ ok: true, done: true }));
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].input.text).toContain('tool follow-up');
      expect(fixture.observations).toEqual([]);
      expect(fixture.journalTurns.size).toBe(0);
      expect(fixture.journalMessages.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('forwards an already-committed suppress local id for provider correlation without persisting again', async () => {
    const fixture = await createTurnStreamFixture();
    try {
      await expect(commitVoiceAgentUserTranscript({ ...fixture, text: 'already committed user', localId: 'already-committed' })).resolves.toEqual({ ok: true });
      const streamId = requireStream(await fixture.start({ message: 'permission fallback', userTranscript: { mode: 'suppress', localId: 'already-committed' } }));
      await vi.waitFor(async () => expect(await fixture.read(streamId)).toMatchObject({ ok: true, done: true }));
      expect(fixture.requests[0].inputIds).toEqual(['already-committed']);
      expect([...fixture.journalMessages.values()].filter((row) => row.messageRole === 'user')).toHaveLength(1);
      expect([...fixture.journalMessages.values()].filter((row) => row.messageRole === 'agent')).toMatchObject([{ localId: `${streamId}:assistant` }]);
      expect(fixture.journalTurns.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('keeps persisted turn metadata keyed by the manager voiceAgentId rather than the execution run id', async () => {
    const fixture = await createTurnStreamFixture();
    try {
      const streamId = requireStream(await fixture.start({ message: 'hello' }));
      await awaitFinished(fixture, streamId);
      const turn = fixture.journalTurns.get(streamId)!;
      expect(turn.user.content).toMatchObject({ t: 'plain', v: { content: { text: 'hello' }, meta: {
        happierProvenanceV1: { v: 1, kind: 'host', producer: 'executionRunVoice' },
        happier: { kind: 'voice_agent_turn.v1', payload: { voiceAgentId: fixture.ctrl.voiceAgentId, runId: 'run_1', role: 'user' } },
      } } });
      expect(turn.assistant.content).toMatchObject({ t: 'plain', v: { content: { type: 'acp', data: { type: 'message', message: 'assistant reply' } }, meta: {
        happier: { kind: 'voice_agent_turn.v1', payload: { voiceAgentId: fixture.ctrl.voiceAgentId, runId: 'run_1', role: 'assistant' } },
      } } });
      const read = await fixture.read(streamId);
      expect(read).toMatchObject({ ok: true, done: true });
      if (read.ok) expect(read.events).toContainEqual(expect.objectContaining({ t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final', turnId: streamId, text: 'assistant reply' }) }));
      expect(fixture.journalTurns.size).toBe(1);
    } finally { await fixture.dispose(); }
  });

  it('commits the terminal transcript pair when the producer finishes even if no stream reader arrives', async () => {
    const fixture = await createTurnStreamFixture({ reply: () => 'assistant persisted without a read' });
    try {
      const streamId = requireStream(await fixture.start({ message: 'persist this final' }));
      await awaitFinished(fixture, streamId);
      expect(fixture.journalTurns.get(streamId)).toMatchObject({ turnId: streamId,
        user: { content: { t: 'plain', v: { content: { text: 'persist this final' } } } },
        assistant: { content: { t: 'plain', v: { content: { type: 'acp', data: { type: 'message', message: 'assistant persisted without a read' } } } } },
      });
      expect(fixture.ctrl.internalStreamIdByExternal.has(streamId)).toBe(true);
      expect(fixture.ctrl.terminalReadByExternalStreamId.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('does not persist either side of a persistent turn that is cancelled', async () => {
    const fixture = await createTurnStreamFixture({ onSend() {} });
    try {
      const streamId = requireStream(await fixture.start({ message: 'cancel me' }));
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      await expect(fixture.cancel(streamId)).resolves.toEqual({ ok: true });
      expect(fixture.journalTurns.size).toBe(0);
      expect(fixture.observations).toEqual([]);
      expect(fixture.journalMessages.size).toBe(0);
      expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.size).toBe(0);
      expect(fixture.ctrl.terminalReadByExternalStreamId.size).toBe(0);
      expect(fixture.ctrl.readInFlightByExternalStreamId.size).toBe(0);
      expect(fixture.ctrl.internalStreamIdByExternal.size).toBe(0);
      expect(fixture.ctrl.externalStreamIdByInternal.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('fails closed at producer completion when durable transcript custody rejects the final', async () => {
    const fixture = await createTurnStreamFixture({ reply: () => 'assistant final' });
    try {
      fixture.setStorage('failed');
      const streamId = requireStream(await fixture.start({ message: 'persist me' }));
      await fixture.writeStarted;
      await vi.waitFor(async () => {
        const read = await fixture.read(streamId);
        expect(read).toMatchObject({ ok: true, done: true });
        if (read.ok) {
          expect(read.events).toContainEqual(expect.objectContaining({ t: 'error' }));
          expect(read.events).not.toContainEqual(expect.objectContaining({ t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final' }) }));
        }
      });
      expect(fixture.journalTurns.size).toBe(0);
      expect(fixture.observations).toEqual([]);
      expect(fixture.journalMessages.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('single-flights concurrent terminal reads without giving readers transcript-write authority', async () => {
    const fixture = await createTurnStreamFixture();
    try {
      const streamId = requireStream(await fixture.start({ message: 'user' }));
      await awaitFinished(fixture, streamId);
      const readObserver = vi.spyOn(fixture.manager, 'readTurnStream');
      const commitObserver = vi.spyOn(fixture.transcriptWriter, 'commitVoiceAgentTranscriptTurn');
      const results = await Promise.all([fixture.read(streamId), fixture.read(streamId)]);
      expect(results[0]).toMatchObject({ ok: true, done: true });
      expect(results[1]).toEqual(results[0]);
      expect(readObserver).toHaveBeenCalledTimes(1);
      expect(commitObserver).not.toHaveBeenCalled();
      expect(fixture.journalTurns.size).toBe(1);
      expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.size).toBe(0);
      expect(fixture.ctrl.readInFlightByExternalStreamId.size).toBe(0);
      commitObserver.mockRestore(); readObserver.mockRestore();
    } finally { await fixture.dispose(); }
  });

  it('integrates the real manager and bridge across invalid cursors, partial reads, durable handoff, and cancellation', async () => {
    const fixture = await createTurnStreamFixture({ onSend(request, publish) {
      if (request.input.text.includes('cancel this')) return;
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'assistant ' });
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'reply' });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    } });
    try {
      const streamId = requireStream(await fixture.start({ message: 'hello' }));
      await awaitFinished(fixture, streamId);
      await expect(fixture.read(streamId, { cursor: 999 })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_invalid_action_input' });
      expect(fixture.ctrl.internalStreamIdByExternal.has(streamId)).toBe(true);
      const observed: unknown[] = [];
      let cursor = 0;
      let done = false;
      while (!done) {
        const read = await fixture.read(streamId, { cursor, maxEvents: 1 });
        if (!read.ok) throw new Error(read.error);
        observed.push(...read.events); cursor = read.nextCursor; done = read.done;
      }
      expect(observed).toContainEqual(expect.objectContaining({ t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final', turnId: streamId, text: 'assistant reply' }) }));
      expect(fixture.journalTurns.get(streamId)).toMatchObject({ turnId: streamId,
        user: { content: { t: 'plain', v: { content: { text: 'hello' } } } }, assistant: { content: { t: 'plain', v: { content: { type: 'acp', data: { type: 'message', message: 'assistant reply' } } } } },
      });
      expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.size).toBe(0);
      await expect(fixture.cancel('stream_foreign')).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_stream_not_found' });
      await expect(fixture.cancel(streamId)).resolves.toEqual({ ok: true });
      expect(fixture.ctrl.internalStreamIdByExternal.size).toBe(0);
      expect(fixture.ctrl.externalStreamIdByInternal.size).toBe(0);
      expect(fixture.ctrl.terminalReadByExternalStreamId.size).toBe(0);
      await expect(fixture.read(streamId, { cursor })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_stream_not_found' });
      const cancelled = requireStream(await fixture.start({ message: 'cancel this' }));
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
      await expect(fixture.cancel(cancelled)).resolves.toEqual({ ok: true });
      expect(fixture.journalTurns.size).toBe(1);
    } finally { await fixture.dispose(); }
  });

  it('rejects completed-but-unread cancellation and preserves matching history and durable intent across adjacent same-text turns', async () => {
    const fixture = await createTurnStreamFixture({ reply: (prompt, index) => prompt.includes('preparing a single instruction message') ? `commit-${index}` : `assistant-${index}` });
    try {
      const finishTurn = async (message: string) => {
        const streamId = requireStream(await fixture.start({ message }));
        await awaitFinished(fixture, streamId);
        await expect(fixture.cancel(streamId)).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
        expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.has(streamId)).toBe(true);
        await expect(fixture.read(streamId, { cursor: 0, maxEvents: 128 })).resolves.toMatchObject({ ok: true, done: true });
        return streamId;
      };
      const firstStreamId = await finishTurn('same user text');
      const firstCommit = await fixture.manager.commit({ voiceAgentId: fixture.ctrl.voiceAgentId, maxChars: 10_000 });
      expect(firstCommit.commitText).toContain('commit-');
      expect(fixture.requests.at(-1)?.input.text).toContain('User: same user text');
      expect(fixture.requests.at(-1)?.input.text).toContain('Voice agent: assistant-1');
      const secondStreamId = await finishTurn('same user text');
      expect(secondStreamId).not.toBe(firstStreamId);
      expect([...fixture.journalTurns.keys()]).toEqual([firstStreamId, secondStreamId]);
      expect(fixture.getOpenCount()).toBe(1);
      const third = requireStream(await fixture.start({ message: 'commit race' }));
      await awaitFinished(fixture, third);
      const committing = fixture.manager.commit({ voiceAgentId: fixture.ctrl.voiceAgentId, maxChars: 10_000 });
      const cancelling = fixture.cancel(third);
      await expect(committing).resolves.toMatchObject({ commitText: expect.any(String) });
      await expect(cancelling).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      await expect(fixture.read(third, { cursor: 0, maxEvents: 128 })).resolves.toMatchObject({ ok: true, done: true });
      expect([...fixture.journalTurns.keys()]).toEqual([firstStreamId, secondStreamId, third]);
    } finally { await fixture.dispose(); }
  });

  it('rejects cancellation while a producer final is crossing the durable handoff boundary', async () => {
    const fixture = await createTurnStreamFixture({ reply: () => 'durable assistant' });
    try {
      fixture.setStorage('held');
      const streamId = requireStream(await fixture.start({ message: 'persist race' }));
      await fixture.writeStarted;
      await expect(fixture.cancel(streamId)).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.has(streamId)).toBe(true);
      expect(fixture.journalTurns.size).toBe(0);
      expect(fixture.observations).toEqual([]);
      expect(fixture.journalMessages.size).toBe(0);
      fixture.releaseWrite();
      await awaitFinished(fixture, streamId);
      await expect(fixture.read(streamId, { cursor: 0, maxEvents: 128 })).resolves.toMatchObject({ ok: true, done: true });
      expect(fixture.ctrl.pendingTranscriptTurnByExternalStreamId.has(streamId)).toBe(false);
      expect(fixture.journalTurns.get(streamId)).toMatchObject({ turnId: streamId });
    } finally { await fixture.dispose(); }
  });
});
