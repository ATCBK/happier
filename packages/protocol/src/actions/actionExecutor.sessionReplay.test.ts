import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),

    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    daemonMemorySearch: vi.fn(async () => ({ v: 1, ok: true as const, hits: [] })),
    daemonMemoryGetWindow: vi.fn(async () => ({ v: 1, snippets: [], citations: [] })),
    daemonMemoryEnsureUpToDate: vi.fn(async () => ({ ok: true })),

    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  } as ActionExecutorDeps;
}

describe('createActionExecutor (session.continue_with_replay)', () => {
  it('preserves canonical same-Session transition effects and exact rich input', async () => {
    const request = { sessionId: 'same-session', expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'codex' }, input: { text: 'exact attachment prompt', localId: 'first-input',
        meta: { displayText: 'Attachment', reasoningEffort: 'high' } } };
    const result = { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' };
    const sessionAgentTransition = vi.fn(async () => result);
    const executor = createActionExecutor(createDeps({ sessionAgentTransition }));
    expect(await executor.execute('session.agent.transition', request, {
      surface: 'ui', authority: 'present_user', bypassApprovals: true,
    })).toEqual({ ok: true, result });
    expect(sessionAgentTransition).toHaveBeenCalledWith(expect.objectContaining({ request: { v: 1, ...request } }));
  });

  it('rejects Agent permission escalation before stopping and retains the causal witness for an unmodified input', async () => {
    const sessionAgentTransition = vi.fn(async () => ({ type: 'accepted', localId: 'first-input' }));
    const executor = createActionExecutor(createDeps({ sessionAgentTransition }));
    const request = { sessionId: 'same-session', expectedCurrentAgentId: 'claude',
      selection: { v: 1, agentId: 'codex' }, input: { text: 'exact prompt', localId: 'first-input', meta: {} } };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, bypassApprovals: true,
      defaultSessionId: 'source-session', callerPermissionMode: 'yolo',
      actionCaller: { kind: 'session' as const, sessionId: 'source-session', starterDepth: 0, turnDepth: 0 },
      sessionInputSource: { sourceSessionId: 'source-session', sourceTurnId: 'turn-1', via: 'action' },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } };
    expect(await executor.execute('session.agent.transition', { ...request,
      input: { ...request.input, meta: { permissionMode: 'yolo' } } }, context)).toMatchObject({ ok: false });
    expect(sessionAgentTransition).not.toHaveBeenCalled();
    expect(await executor.execute('session.agent.transition', request, context)).toMatchObject({ ok: true });
    expect(sessionAgentTransition).toHaveBeenCalledWith(expect.objectContaining({
      request: { v: 1, ...request }, sessionInputSource: expect.objectContaining({
        sourceSessionId: 'source-session', causalPermissionAuthority: context.causalPermissionAuthority,
      }),
    }));
  });
  it('delegates replay continuation input to the replay dependency', async () => {
    const sessionContinueWithReplay = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' }));
    const deps = createDeps({
      sessionContinueWithReplay,
    });
    const executor = createActionExecutor(deps);
    const input = {
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_parent',
        strategy: 'recent_messages',
      },
    };

    const signal = new AbortController().signal;
    const result = await executor.execute('session.continue_with_replay', input, { surface: 'rpc', signal });

    expect(result).toEqual({ ok: true, result: { type: 'success', sessionId: 'sess_child' } });
    expect(sessionContinueWithReplay).toHaveBeenCalledWith({ ...input, signal });
  });
});
