import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { setSessionArchivedState } from './setSessionArchivedState';

const boundary = vi.hoisted(() => ({ createSocket: vi.fn(), callMachineRpc: vi.fn() }));
// Socket creation and machine RPC are network boundaries; admission and stop policy stay real.
vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: boundary.createSocket,
  createSessionScopedSocketConnection: () => {
    const socket = boundary.createSocket();
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc: boundary.callMachineRpc,
  readMachineRpcRequestDisposition: () => null,
}));

describe('setSessionArchivedState', () => {
  const sessionId = 'c' + 'a'.repeat(24);
  const credentials = { token: 'token-1', encryption: null };
  let active: boolean;
  let socket: EventEmitter;

  beforeEach(() => {
    active = false;
    boundary.callMachineRpc.mockReset();
    socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
    boundary.createSocket.mockReturnValue(socket);
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, active, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: 'machine-1' }) }) } }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('archives an inactive session directly without issuing a stop request', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, archivedAt: 123 } });
    await expect(setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: true }))
      .resolves.toEqual({ ok: true, sessionId, archivedAt: 123 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(boundary.callMachineRpc).not.toHaveBeenCalled();
  });

  it('unarchives a session directly', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, archivedAt: null } });
    await expect(setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: false }))
      .resolves.toEqual({ ok: true, sessionId, archivedAt: null });
    expect(post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/unarchive`),
      expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }));
    expect(boundary.callMachineRpc).not.toHaveBeenCalled();
  });

  it('retains original authorization while stopping an active session and retrying archive', async () => {
    active = true;
    const post = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 409, data: { error: 'session_active' } })
      .mockResolvedValueOnce({ status: 200, data: { success: true, archivedAt: 456 } });
    boundary.callMachineRpc.mockImplementation(async () => { active = false; return { status: 'stopped' }; });
    const externalAction = { context: { surface: 'agent' as const }, effectActionId: 'session.archive',
      installationId: 'installation', privateKey: new Uint8Array(64) };
    // Signing is supplied by the Action owner; this HTTP boundary verifies that
    // lookup, Stop observations and the archive retry cannot borrow the bearer.
    const resolveAuthorizationHeaders = () => ({ 'X-Test-Original-Archive': 'signed' });
    await expect(setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: true,
      externalAction, resolveAuthorizationHeaders }))
      .resolves.toEqual({ ok: true, sessionId, archivedAt: 456 });
    expect(boundary.callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1', method: RPC_METHODS.STOP_SESSION, request: { sessionId },
      externalAction: { ...externalAction, effectActionId: 'session.stop' },
    }));
    expect(post).toHaveBeenCalledTimes(2);
    for (const [, config] of vi.mocked(axios.get).mock.calls) {
      expect(config?.headers).toMatchObject({ 'X-Test-Original-Archive': 'signed' });
      expect(config?.headers).not.toHaveProperty('Authorization');
    }
    for (const [, , config] of post.mock.calls) {
      expect(config?.headers).toMatchObject({ 'X-Test-Original-Archive': 'signed' });
      expect(config?.headers).not.toHaveProperty('Authorization');
    }
  });

  it('retries archive after an unconfirmed stop when the session becomes archivable immediately after', async () => {
    active = true;
    const post = vi.spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 409, data: { error: 'session_active' } })
      .mockResolvedValueOnce({ status: 200, data: { success: true, archivedAt: 789 } });
    boundary.callMachineRpc.mockResolvedValue({ status: 'incomplete', reason: 'transport_ambiguous' });
    await expect(setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: true }))
      .resolves.toEqual({ ok: true, sessionId, archivedAt: 789 });
    expect(boundary.callMachineRpc).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('preserves a definitive Stop refusal without retrying the archive mutation', async () => {
    active = true;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'session_active' } });
    const refusal = { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop',
      details: { cause: 'target_outside_led_subtree' } };
    boundary.callMachineRpc.mockResolvedValue(refusal);
    await expect(setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: true }))
      .resolves.toMatchObject(refusal);
    expect(post).toHaveBeenCalledTimes(1);
    expect(active).toBe(true);
  });

  it('parks without polling after stop until an inactive event allows archive', async () => {
    vi.useFakeTimers();
    active = true;
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => active
      ? { status: 409, data: { error: 'session_active' } }
      : { status: 200, data: { success: true, archivedAt: 999 } });
    boundary.callMachineRpc.mockResolvedValue({ status: 'incomplete', reason: 'transport_ambiguous' });
    const result = setSessionArchivedState({ credentials, idOrPrefix: sessionId, archived: true });
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.mocked(axios.get).mock.calls.length;
    const writes = post.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(reads);
    expect(post.mock.calls).toHaveLength(writes);
    active = false;
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ ok: true, sessionId, archivedAt: 999 });
    expect(boundary.callMachineRpc).toHaveBeenCalledTimes(1);
    expect(socket.eventNames()).toEqual([]);
  });
});
