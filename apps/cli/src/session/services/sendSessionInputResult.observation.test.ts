import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { waitForSessionInputResult } from './sendSessionMessage';
import { configuration } from '@/configuration';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { observeWorkflowSessionInputResult } from '@/daemon/workflows/stepExecution';
import { SessionInputAuthorityV2Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { stampTurnFacts } from '@/agent/runtime/session/turn/stampTurnFacts';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { WORKFLOW_STEP_INPUT_EVENT_MESSAGE } from '@/session/shared/sessionTurnLifecycle';

const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/api/session/sockets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createSessionScopedSocket: socketBoundary.create,
  createSessionScopedSocketConnection: () => {
    const socket = socketBoundary.create();
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['single', 'shared', 'quiet'] as const)('captures only the host-settled final reply with %s inputs and exact turn anchors', async (mode) => {
  const sessionId = 'c' + 'f'.repeat(24);
  const socket = Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  });
  socketBoundary.create.mockReturnValue(socket);
  let phase: 'opening' | 'alpha_done' | 'both_done' | 'ledger_unavailable' = 'opening';
  const row = (seq: number, localId: string | null, value: unknown) => ({
    id: `row-${seq}`, seq, localId, createdAt: seq, updatedAt: seq,
    content: { t: 'plain', v: value },
  });
  const invocation = (name: string) => ({ runId: 'workflow-run',
    invocationRecordId: name === 'alpha' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' });
  const inputId = (name: string) => mode === 'quiet'
    ? deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...invocation(name) }) : `${name}-input`;
  const quietFacts = (name: string) => mode === 'quiet'
    ? stampTurnFacts({ sessionWorkDepth: 0, hostContextOnly: true,
      workflowInvocation: invocation(name), workflowWorkDepth: 1 }) : {};
  // Both inputs are durable before either native reply. Transcript adjacency
  // therefore cannot establish which input the provider actually consumed.
  const input = (seq: number, name: string, invocationRecordId: string) => row(seq, inputId(name), mode === 'quiet'
    ? buildAcpAgentMessageEnvelope({ provider: 'claude', body: { id: inputId(name), type: 'event',
      data: { type: 'message', message: WORKFLOW_STEP_INPUT_EVENT_MESSAGE } } }) : {
    role: 'user', content: { type: 'text', text: name }, meta: { happierInputAuthorityV1: SessionInputAuthorityV2Schema.parse({
      v: 2, producer: 'workflow', caller: { kind: 'host' },
      permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' },
      workflow: { runId: 'workflow-run', invocationRecordId, purpose: 'invocation', stepOrdinal: '1', workDepth: 1 },
    }) },
  });
  const inputs = [input(7, 'alpha', '00000000-0000-4000-8000-000000000001'),
    ...(mode !== 'single' ? [input(8, 'beta', '00000000-0000-4000-8000-000000000002')] : [])];
  const text = (seq: number, value: string) => row(seq, null, { role: 'agent', content: { type: 'text', text: value } });
  const usage = (seq: number, input: number) => row(seq, null, { role: 'agent',
    content: { type: 'acp', agentId: 'codex', data: {
      type: 'token_count', scope: 'turn_delta', source: 'provider_result', tokens: { input, output: 2 },
    } } });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: {
      message: inputs[url.endsWith(encodeURIComponent(inputId('beta'))) ? 1 : 0] } };
    if (url.endsWith('/turns') && phase === 'ledger_unavailable') return { status: 404, data: {} };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 12,
      turns: [
        { turnId: 'alpha-turn', status: phase === 'opening' ? 'in_progress' : 'completed', startedAt: 7, updatedAt: 11,
          ...quietFacts('alpha'),
          transcriptAnchors: { ...(mode === 'quiet' ? {} : { startUserMessageSeq: 7, userMessageSeqs: [7] }), startSeqInclusive: 7,
            ...(phase === 'opening' ? {} : { endSeqInclusive: 11, finalAssistantMessageSeq: 11 }) } },
        ...(phase === 'both_done' && mode !== 'single' ? [{ turnId: 'beta-turn', status: 'completed', startedAt: 7, updatedAt: 13,
          ...quietFacts('beta'),
          transcriptAnchors: { ...(mode === 'quiet' ? {} : { startUserMessageSeq: 8, userMessageSeqs: [8] }), startSeqInclusive: 8,
            endSeqInclusive: 13, finalAssistantMessageSeq: 13 } }] : []),
      ] } };
    if (url.includes('/messages?')) {
      const rows = [...inputs, text(9, "I'll start by setting the session title"),
        ...(phase === 'opening' ? [] : [usage(10, 7), text(11, 'QA-FIN38b TOOL DONE alpha')]),
        ...(phase === 'both_done' && mode !== 'single' ? [usage(12, 9), text(13, 'QA-FIN38b TOOL DONE beta')] : [])];
      const query = new URL(url).searchParams;
      return { status: 200, data: { messages: rows.filter(item => item.seq > Number(query.get('afterSeq') ?? 0)) } };
    }
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const observe = (localId: string) => observeWorkflowSessionInputResult({
    credentials: { token: 'token', encryption: null }, sessionId, localId, deadlineMs: 0,
  });
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  if (mode !== 'single') await expect(observe(inputId('beta'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  phase = 'alpha_done';
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true,
    result: { kind: 'final_text', text: 'QA-FIN38b TOOL DONE alpha', usage: { inputTokens: 7, outputTokens: 2 } } });
  if (mode !== 'single') await expect(observe(inputId('beta'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  phase = 'both_done';
  for (const name of mode !== 'single' ? ['alpha', 'beta'] : ['alpha']) {
    await expect(observe(inputId(name))).resolves.toMatchObject({ ok: true,
      result: { kind: 'final_text', text: `QA-FIN38b TOOL DONE ${name}`,
        usage: { inputTokens: name === 'alpha' ? 7 : 9, outputTokens: 2 } } });
  }
  phase = 'ledger_unavailable';
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
});

it('keeps the containing deadline authoritative when a change races a parked read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const socket = Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  });
  socketBoundary.create.mockReturnValue(socket);
  const events = openSessionEventSource({ token: 'token', sessionId: 'session-1' });
  const revision = events.currentRevision();
  socket.emit('connect');
  try {
    await expect(events.waitForChange(revision, { deadlineMs: 100 })).resolves.toBe(false);
  } finally {
    await events.close();
  }
});

it.each(['materialization', 'completion'] as const)('parks exact input %s and catches completion missed while disconnected', async (phase) => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
  socket.connect.mockImplementation(() => { socket.connected = true; socket.emit('connect'); });
  socket.disconnect.mockImplementation(() => { socket.connected = false; });
  socketBoundary.create.mockReturnValue(socket);
  const sessionId = 'c' + 'b'.repeat(24);
  const localId = 'input-event-1';
  const input = { id: 'input', seq: 7, localId, createdAt: 1, updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
  let completed = false;
  let materialized = phase === 'completion';
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    reads.push(url);
    if (url.endsWith('/turns')) return { status: 404, data: {} };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.includes('/messages/by-local-id/')) {
      if (!materialized) throw Object.assign(new Error('Message not found'), {
        isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
      });
      return { status: 200, data: { message: input } };
    }
    if (url.includes('/messages?')) return { status: 200, data: { messages: completed ? [input,
      { id: 'text', seq: 8, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: {
        type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Done after reconnect' } } } } },
      { id: 'done', seq: 9, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: {
        type: 'acp', data: { type: 'task_complete', id: 'turn-1' } } } } },
    ] : [input] } };
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const result = waitForSessionInputResult({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, localId, timeoutMs: 10_000 });
  await vi.advanceTimersByTimeAsync(0);
  const baselineReads = reads.length;
  // Provisional stream deltas do not change retained exact-input/turn evidence.
  socket.emit('ephemeral', { type: 'transcript-stream-segment-delta', sessionId,
    message: { localId: 'live-segment', tick: 1, baseLength: 0, createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Still working' } } } } });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reads).toHaveLength(baselineReads);
  socket.emit('disconnect', 'transport close');
  completed = true;
  materialized = true;
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toMatchObject({ ok: true, localId,
    result: { kind: 'final_text', text: 'Done after reconnect' } });
  expect(socket.eventNames()).toEqual([]);
  expect(socket.connected).toBe(false);
});

it('reads settled exact input evidence once even when resolving transport passes the observation deadline', async () => {
  const sessionId = 'c' + 'a'.repeat(24);
  const localId = 'input-1';
  let currentTime = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  const input = { id: 'input-row', seq: 7, localId, createdAt: 1, updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
  const lifecycle = (type: string) => ({ role: 'agent', content: { type: 'acp', data: { type, id: 'turn-1' } } });
  // HTTP and clock are system boundaries; resolution and transcript classification stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/turns')) return { status: 404, data: {} };
    if (url.endsWith('/v1/account/encryption/currentness')) {
      currentTime = 200;
      return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    }
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
    if (url.includes('/messages?')) return { status: 200, data: { messages: [input,
      ...[lifecycle('task_started'), { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Done' } } }, lifecycle('task_complete')]
        .map((value, ordinal) => ({ id: `result-${ordinal}`, localId: null, seq: 8 + ordinal, createdAt: 2,
          content: { t: 'plain', v: value } })),
    ] } };
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const result = await waitForSessionInputResult({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId,
    observation: { kind: 'absolute_deadline', deadlineMs: 100 } });
  expect(get.mock.calls.map(([url]) => url)).toContainEqual(expect.stringContaining('/messages/by-local-id/'));
  const nativeRead = get.mock.calls.find(([url]) => url.includes('/messages/by-local-id/'));
  expect(nativeRead?.[1]?.timeout).toBe(configuration.transcriptLookupRequestTimeoutMs);
  expect(result)
    .toMatchObject({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'Done' } });
});
