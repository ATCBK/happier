import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const boundaries = vi.hoisted(() => ({
  discard: vi.fn(),
  fetchSession: vi.fn(),
  fetchAccountCurrentness: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
  discardPendingQueueV2Messages: boundaries.discard,
}));
vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocketConnection: () => {
    // Socket I/O is the boundary; exact-input observation stays real.
    const socket = Object.assign(new EventEmitter(), { connected: false,
      connect: () => {}, disconnect: () => {}, close: () => {} });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: boundaries.fetchSession,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: boundaries.fetchAccountCurrentness,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: boundaries.rpc }));

import { cancelSessionInput } from './cancelSessionInput';
import { createWorkflowInvocationRecoveryObserver } from '@/daemon/workflows/invocationRecoveryObserver';
import { createWorkflowSessionStepExecutor } from '@/daemon/workflows/sessionStepExecutor';
import { WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from '@/daemon/workflows/coordinator';
import { createDeferred } from '@/testkit/async/deferred';

const sessionId = 'session-full-id-1';

describe('cancelSessionInput', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    boundaries.fetchAccountCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    boundaries.fetchSession.mockResolvedValue(createSessionRecordFixture({ id: sessionId, active: true,
      activeAt: 1, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }) }));
  });
  it('retires an exact pending input without cancelling a whole Session', async () => {
    boundaries.discard.mockResolvedValueOnce(1);
    await expect(cancelSessionInput({
      credentials: { token: 'token', encryption: null },
      sessionId, localId: 'local-1',
    })).resolves.toEqual({ kind: 'pending_retired' });
    expect(boundaries.fetchSession).not.toHaveBeenCalled();
    expect(boundaries.rpc).not.toHaveBeenCalled();
  });

  it('requests exact-turn cancellation only after pending materialization', async () => {
    boundaries.discard.mockRejectedValueOnce(Object.assign(new Error('not found'), {
      isAxiosError: true,
      response: { status: 404, data: { error: 'not-found' } },
    }));
    boundaries.rpc.mockResolvedValueOnce({ ok: true, status: 'cancelled', sessionId, localId: 'local-1' });
    await expect(cancelSessionInput({
      credentials: { token: 'token', encryption: null },
      sessionId, localId: 'local-1',
    })).resolves.toEqual({ kind: 'turn_cancel_requested' });
    expect(boundaries.rpc).toHaveBeenCalledWith(expect.objectContaining({
      request: { sessionId, localId: 'local-1' },
    }));
  });

  it('keeps privacy-collapsed Session absence or denial unavailable without an existence probe', async () => {
    boundaries.discard.mockRejectedValueOnce(Object.assign(new Error('unavailable'), {
      isAxiosError: true,
      response: { status: 404, data: { error: 'session-not-found' } },
    }));
    await expect(cancelSessionInput({
      credentials: { token: 'token', encryption: null },
      sessionId, localId: 'local-1',
    })).resolves.toEqual({ kind: 'turn_cancel_unavailable', code: 'session-not-found' });
    expect(boundaries.fetchSession).not.toHaveBeenCalled();
    expect(boundaries.rpc).not.toHaveBeenCalled();
  });

  it('keeps an accepted Workflow input unresolved in execution and recovery after submit authority is denied', async () => {
    boundaries.discard.mockRejectedValue(Object.assign(new Error('unavailable'), {
      isAxiosError: true,
      response: { status: 404, data: { error: 'session-not-found' } },
    }));
    const invocation = {
      kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
      invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: 'invocation',
      execution: { kind: 'session' as const, sessionId, localInputId: 'local-1' },
      workspace: { descriptor: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
    };
    const observing = createDeferred<void>();
    let executionStarted = false;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.includes('/messages/by-local-id/')) {
        if (executionStarted) observing.resolve();
        throw Object.assign(new Error('Message not found'), {
          isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
        });
      }
      if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
      throw new Error(`unexpected_http_read:${url}`);
    });
    const recover = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine',
      actionExecutor: { execute: async () => { throw new Error('Session recovery cannot invoke an Action'); } },
    });
    await expect(recover({ progress: invocation, terminalParent: false, cancellationRequested: true }))
      .resolves.toMatchObject({ kind: 'unresolved', code: 'session-not-found' });

    const controller = new AbortController();
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('accepted input cannot prepare'); },
      materializeConversation: async () => { throw new Error('accepted input cannot materialize'); },
    });
    executionStarted = true;
    const execution = execute({
      runId: 'run', signal: controller.signal,
      step: { kind: 'step', id: 'step', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation, input: { text: 'work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    });
    await observing.promise;
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    await expect(execution).resolves.toEqual({ kind: 'needs_attention', code: 'session-not-found' });
    expect(boundaries.rpc).not.toHaveBeenCalled();
  });

  it.each(['notCurrent', 'notRunning', 'unsupported', 'cancel_failed'] as const)(
    'preserves an exact-turn %s refusal instead of reporting cancellation requested', async (status) => {
      boundaries.discard.mockRejectedValueOnce(Object.assign(new Error('not found'), {
        isAxiosError: true,
        response: { status: 404, data: { error: 'not-found' } },
      }));
      boundaries.rpc.mockResolvedValueOnce({ ok: false, status, sessionId, localId: 'local-1' });
      await expect(cancelSessionInput({
        credentials: { token: 'token', encryption: null },
        sessionId, localId: 'local-1',
      })).resolves.toEqual({ kind: 'turn_cancel_refused', status, code: status });
    },
  );

  it.each([
    { response: { ok: true }, code: 'session_input_cancel_invalid_result' },
    { response: { ok: true, status: 'cancelled', sessionId, localId: 'another-input' }, code: 'session_input_cancel_identity_mismatch' },
  ])('rejects an invalid exact-turn cancellation acknowledgement ($code)', async ({ response, code }) => {
    boundaries.discard.mockRejectedValueOnce(Object.assign(new Error('not found'), {
      isAxiosError: true,
      response: { status: 404, data: { error: 'not-found' } },
    }));
    boundaries.rpc.mockResolvedValueOnce(response);
    await expect(cancelSessionInput({
      credentials: { token: 'token', encryption: null },
      sessionId, localId: 'local-1',
    })).resolves.toEqual({ kind: 'turn_cancel_unavailable', code });
  });
});
