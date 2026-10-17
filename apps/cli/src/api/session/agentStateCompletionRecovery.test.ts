import { describe, expect, it, vi } from 'vitest';

import type { AgentState } from '../types';
import { updateSessionAgentStateWithAck } from './stateUpdates';
import { AgentStateCompletionRecovery } from './agentStateCompletionRecovery';

type AckSocket = Parameters<typeof updateSessionAgentStateWithAck>[0]['socket'];

function createHarness(initialState: AgentState) {
  let state: AgentState | null = initialState;
  let version = 1;
  let serverState: AgentState = initialState;
  let serverVersion = 1;
  let rejectedWrites = 0;
  let attempts = 0;
  const socket: AckSocket = {
    emitWithAck: async (_event: string, payload: { agentState: string; expectedVersion: number }) => {
      attempts++;
      if (rejectedWrites > 0) {
        rejectedWrites--;
        throw new Error('transport disconnected');
      }
      if (payload.expectedVersion !== serverVersion) {
        return {
          result: 'version-mismatch',
          version: serverVersion,
          agentState: JSON.stringify(serverState),
        };
      }
      serverState = JSON.parse(payload.agentState) as AgentState;
      serverVersion++;
      return { result: 'success', version: serverVersion, agentState: payload.agentState };
    },
  } as AckSocket;
  const write = (handler: (current: AgentState) => AgentState) => updateSessionAgentStateWithAck({
    socket,
    sessionId: 'session-1',
    sessionEncryptionMode: 'plain',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    getAgentState: () => state,
    setAgentState: (next) => { state = next; },
    getAgentStateVersion: () => version,
    setAgentStateVersion: (next) => { version = next; },
    syncSessionSnapshotFromServer: async () => {
      state = serverState;
      version = serverVersion;
    },
    handler,
  });
  return {
    write,
    get state() { return state; },
    get serverState() { return serverState; },
    get attempts() { return attempts; },
    rejectNextWrites(count: number) { rejectedWrites = count; },
    replaceSnapshot(next: AgentState, nextVersion: number) {
      state = next;
      version = nextVersion;
      serverState = next;
      serverVersion = nextVersion;
    },
    advanceServerVersion() { serverVersion++; },
  };
}

function completeRequest(state: AgentState, requestId: string): AgentState {
  const request = state.requests?.[requestId];
  if (!request) return state;
  const requests = { ...state.requests };
  delete requests[requestId];
  const completedRequests = {
    ...state.completedRequests,
    [requestId]: {
      ...request,
      completedAt: 10,
      status: 'approved' as const,
    },
  };
  return { ...state, requests, completedRequests };
}

function recordFallbackCompletion(state: AgentState, requestId: string, status: 'approved' | 'denied'): AgentState {
  const completedRequests = {
    ...state.completedRequests,
    [requestId]: {
      tool: 'Write',
      arguments: { path: '/tmp/a' },
      createdAt: 1,
      completedAt: 12,
      status,
    },
  };
  return { ...state, completedRequests };
}

describe('AgentStateCompletionRecovery', () => {
  it('replays a failed completion before an unrelated successful state update', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      requests: {
        requestA: { tool: 'Write', arguments: { path: '/tmp/a' }, createdAt: 1 },
        requestB: { tool: 'Bash', arguments: { command: 'echo b' }, createdAt: 2 },
      },
    });
    const recovery = new AgentStateCompletionRecovery(() => harness.state);
    harness.rejectNextWrites(8);
    const pendingCompletion = recovery.runUpdate({
      retainPermissionCompletionsOnFailure: true,
      handler: (state) => completeRequest(state, 'requestA'),
      write: harness.write,
    });
    const failed = pendingCompletion.then(() => null, (error: unknown) => error);

    try {
      await vi.runAllTimersAsync();
      expect(await failed).toBeInstanceOf(Error);
      expect(harness.attempts).toBe(8);
      harness.rejectNextWrites(8);
      const retrySameRequest = recovery.runUpdate({
        retainPermissionCompletionsOnFailure: true,
        handler: (state) => recordFallbackCompletion(state, 'requestA', 'denied'),
        write: harness.write,
      }).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await retrySameRequest).toBeInstanceOf(Error);
      expect(recovery.hasPending()).toBe(true);

      const replayBeforeB = recovery.runUpdate({
        handler: (state) => ({
          ...state,
          capabilities: { ...state.capabilities, inFlightSteer: true },
        }),
        write: harness.write,
      });
      await vi.runAllTimersAsync();
      await replayBeforeB;

      expect(harness.serverState.requests).toEqual({
        requestB: { tool: 'Bash', arguments: { command: 'echo b' }, createdAt: 2 },
      });
      expect(harness.serverState.completedRequests?.requestA).toMatchObject({ status: 'denied' });
      expect(harness.serverState.capabilities?.inFlightSteer).toBe(true);
      expect(recovery.hasPending()).toBe(false);

      harness.rejectNextWrites(8);
      const failedBCompletion = recovery.runUpdate({
        retainPermissionCompletionsOnFailure: true,
        handler: (state) => completeRequest(state, 'requestB'),
        write: harness.write,
      }).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await failedBCompletion).toBeInstanceOf(Error);
      expect(recovery.hasPending()).toBe(true);
      harness.advanceServerVersion();
      const replayAfterCas = recovery.runUpdate({
        handler: (state) => ({ ...state, controlledByUser: true }),
        write: harness.write,
      });
      await vi.runAllTimersAsync();
      await replayAfterCas;
      expect(harness.serverState.completedRequests?.requestB).toMatchObject({ status: 'approved' });
      expect(harness.serverState.controlledByUser).toBe(true);
      expect(recovery.hasPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays an automatic completion only while its expected absence remains true', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ requests: {} });
    const recovery = new AgentStateCompletionRecovery(() => harness.state);
    const automaticCompletion: AgentState = {
      completedRequests: {
        autoA: { tool: 'Bash', arguments: { command: 'echo a' }, createdAt: 3, completedAt: 11, status: 'approved' },
        autoB: { tool: 'Write', arguments: { path: '/tmp/b' }, createdAt: 5, completedAt: 12, status: 'approved' },
      },
    };
    harness.rejectNextWrites(8);
    const failed = recovery.runUpdate({
      retainPermissionCompletionsOnFailure: true,
      handler: (state) => ({ ...state, completedRequests: automaticCompletion.completedRequests }),
      write: harness.write,
    });
    const settled = failed.then(() => null, (error: unknown) => error);
    try {
      await vi.runAllTimersAsync();
      expect(await settled).toBeInstanceOf(Error);
      expect(recovery.hasPending()).toBe(true);
      harness.replaceSnapshot({
        requests: { autoA: { tool: 'Bash', arguments: { command: 'changed' }, createdAt: 4 } },
        completedRequests: {
          autoB: { tool: 'Write', arguments: { path: '/tmp/b' }, createdAt: 5, completedAt: 13, status: 'denied' },
        },
      }, 2);
      await recovery.runUpdate({ handler: (state) => state, write: harness.write });
      expect(harness.serverState.completedRequests?.autoA).toBeUndefined();
      expect(harness.serverState.completedRequests?.autoB).toMatchObject({ status: 'denied', completedAt: 13 });
      expect(harness.serverState.requests?.autoA?.arguments).toEqual({ command: 'changed' });
      expect(recovery.hasPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a completion over a newly claimed same-identity request', async () => {
    vi.useFakeTimers();
    const request = { tool: 'Write', arguments: { path: '/tmp/a' }, createdAt: 1 };
    const harness = createHarness({ requests: { requestA: request } });
    const recovery = new AgentStateCompletionRecovery(() => harness.state);
    harness.rejectNextWrites(8);
    const pendingCompletion = recovery.runUpdate({
      retainPermissionCompletionsOnFailure: true,
      handler: (state) => completeRequest(state, 'requestA'),
      write: harness.write,
    }).then(() => null, (error: unknown) => error);
    try {
      await vi.runAllTimersAsync();
      expect(await pendingCompletion).toBeInstanceOf(Error);
      harness.replaceSnapshot({
        requests: {
          requestA: { ...request, permissionResponseClaimV1: { owner: 'new-runtime' } } as typeof request,
        },
      }, 2);
      await recovery.runUpdate({ handler: (state) => state, write: harness.write });
      expect(harness.serverState.requests?.requestA).toHaveProperty('permissionResponseClaimV1');
      expect(harness.serverState.completedRequests?.requestA).toBeUndefined();
      expect(recovery.hasPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures an automatic completion when the write fails before handler admission', async () => {
    vi.useFakeTimers();
    const harness = createHarness({});
    const recovery = new AgentStateCompletionRecovery(() => null);
    const automaticCompletion: AgentState = {
      completedRequests: {
        autoA: { tool: 'Bash', arguments: { command: 'echo a' }, createdAt: 3, completedAt: 11, status: 'approved' },
      },
    };
    await expect(recovery.runUpdate({
      retainPermissionCompletionsOnFailure: true,
      handler: (state) => ({ ...state, ...automaticCompletion }),
      write: async () => { throw new Error('socket unavailable before update'); },
    })).rejects.toThrow('socket unavailable before update');
    expect(recovery.hasPending()).toBe(true);
    const replay = recovery.runUpdate({ handler: (state) => state, write: harness.write });
    await vi.runAllTimersAsync();
    await replay;
    expect(harness.serverState.completedRequests?.autoA).toMatchObject({ status: 'approved' });
    expect(recovery.hasPending()).toBe(false);
    vi.useRealTimers();
  });

  it('retains every finalized row from one cancellation-style update', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      requests: {
        requestA: { tool: 'Write', arguments: { path: '/tmp/a' }, createdAt: 1 },
        requestB: { tool: 'Bash', arguments: { command: 'echo b' }, createdAt: 2 },
      },
    });
    const recovery = new AgentStateCompletionRecovery(() => harness.state);
    const cancelAll = (state: AgentState): AgentState => ({
      ...state,
      requests: {},
      completedRequests: {
        requestA: { ...state.requests?.requestA!, completedAt: 20, status: 'canceled' },
        requestB: { ...state.requests?.requestB!, completedAt: 20, status: 'canceled' },
      },
    });
    harness.rejectNextWrites(8);
    const failedCancel = recovery.runUpdate({
      retainPermissionCompletionsOnFailure: true,
      handler: cancelAll,
      write: harness.write,
    }).then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failedCancel).toBeInstanceOf(Error);
    expect(recovery.hasPending()).toBe(true);
    const replay = recovery.runUpdate({ handler: (state) => state, write: harness.write });
    await vi.runAllTimersAsync();
    await replay;
    expect(harness.serverState.requests).toEqual({});
    expect(harness.serverState.completedRequests).toMatchObject({
      requestA: { status: 'canceled' },
      requestB: { status: 'canceled' },
    });
    expect(recovery.hasPending()).toBe(false);
    vi.useRealTimers();
  });

  it('does not retain an unmarked UI completion failure', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      requests: { requestA: { tool: 'Write', arguments: { path: '/tmp/a' }, createdAt: 1 } },
    });
    const recovery = new AgentStateCompletionRecovery(() => harness.state);
    harness.rejectNextWrites(8);
    const failed = recovery.runUpdate({
      handler: (state) => completeRequest(state, 'requestA'),
      write: harness.write,
    }).then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failed).toBeInstanceOf(Error);
    expect(recovery.hasPending()).toBe(false);
    vi.useRealTimers();
  });
});
