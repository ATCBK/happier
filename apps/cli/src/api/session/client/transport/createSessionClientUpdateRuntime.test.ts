import { describe, expect, it, vi } from 'vitest';

import type { AgentState, Update } from '../../../types';
import { createSessionClientUpdateRuntime } from './createSessionClientUpdateRuntime';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';

function createRuntime(
  overrides: Partial<Omit<
    Parameters<typeof createSessionClientUpdateRuntime>[0],
    'mode' | 'ctx'
  >> = {},
) {
  return createSessionClientUpdateRuntime({
    serverId: 'home',
    sessionId: 'session-1',
    getMetadata: () => null,
    setMetadata: vi.fn(),
    getMetadataVersion: () => 0,
    setMetadataVersion: vi.fn(),
    getAgentState: () => null,
    setAgentState: vi.fn(),
    getAgentStateVersion: () => 0,
    setAgentStateVersion: vi.fn(),
    applyPendingQueueState: vi.fn(() => false),
    emit: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    initialLastObservedMessageSeq: 0,
    ...overrides,
    mode: 'plain',
    ctx: null,
  });
}

describe('createSessionClientUpdateRuntime', () => {
  it('withdraws retained questions when an exact Session archive update reaches its owner', async () => {
    let archivedAt: number | null = null;
    let state: AgentState = { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
      arguments: { questions: [{ question: 'Continue?' }] }, createdAt: 1 } }, completedRequests: {} };
    const session = { sessionId: 'session-1', getAgentStateSnapshot: () => state,
      getArchivedAtSnapshot: () => archivedAt,
      updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); },
      updateAgentStateRequestSettlement: async (update: (current: AgentState) => AgentState) => { state = update(state); } };
    const store = new AgentStateRequestStore({ session, logPrefix: '[Archive update]' });
    const runtime = createRuntime({ onArchivedAtFromServer: (value) => {
      archivedAt = value;
      store.updateSession(session);
    } });
    const archive = { id: 'archive', seq: 1, createdAt: 1_000,
      body: { t: 'update-session', id: 'other-session', archivedAt: 42 } } as Update;
    runtime.handleUpdate(archive, { source: 'user-scoped' });
    expect(store.hasOutstandingRequest('question')).toBe(true);
    runtime.handleUpdate({ ...archive, body: { ...archive.body, id: 'session-1' } } as Update, { source: 'user-scoped' });
    expect(store.hasOutstandingRequest('question')).toBe(false);
    await vi.waitFor(() => expect(state.completedRequests?.question)
      .toMatchObject({ status: 'canceled', reason: 'Session archived' }));
    store.dispose();
  });

  it('forwards transcript rows as observations without a provider-input consumer dependency', () => {
    const emit = vi.fn();
    const runtime = createRuntime({ emit });
    const update = {
      id: 'update-1', seq: 1, createdAt: 1_000,
      body: {
        t: 'new-message', sid: 'session-1',
        message: {
          id: 'message-1', seq: 4, localId: 'local-1', createdAt: 1_000, updatedAt: 1_000,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'observe me' } } },
        },
      },
    } as Update;

    runtime.handleUpdate(update, { source: 'session-scoped' });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(runtime.getLastObservedUserMessageSeq()).toBe(4);
  });

  it('uses the accepted canonical Pending state for drain notification', () => {
    const canonical = { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 5 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({
      getPendingQueueState: () => canonical,
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'pending-change', seq: 1, createdAt: 1_000,
      body: { t: 'pending-changed', sid: 'session-1', pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(canonical);
  });

  it('forwards an exact execution-run target hint with the canonical Pending state', () => {
    const canonical = { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({
      getPendingQueueState: () => canonical,
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'target-pending-change', seq: 2, createdAt: 1_001,
      body: {
        t: 'pending-changed',
        sid: 'session-1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 6,
        recipient: { kind: 'execution_run', runId: 'run-1' },
      },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(
      canonical,
      { kind: 'execution_run', runId: 'run-1' },
      6,
    );
  });
});
