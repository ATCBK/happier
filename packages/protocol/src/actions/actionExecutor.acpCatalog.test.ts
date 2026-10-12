import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyAcpBackendUpsertV1 } from '../acp/catalog/catalogMutationsV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    // Routing tests exercise the domain ports, not the shared approval owner.
    isActionApprovalRequired: () => false,
    ...overrides,
  });
}

/** An in-memory Account settings owner: the host port only persists what the executor computes. */
function createCatalogStore(initial: unknown) {
  let stored: unknown = initial;
  const updateAccountAcpCatalogSettings = vi.fn(async ({ mutate }: { mutate: (current: unknown) => unknown }) => {
    stored = mutate(stored);
    return { ok: true as const };
  });
  return { read: () => stored, updateAccountAcpCatalogSettings };
}

const authored = {
  id: 'my-agent',
  name: 'my-agent',
  title: 'My agent',
  launch: { kind: 'command' as const, command: 'my-agent', args: ['--acp'] },
};

describe('createActionExecutor (custom ACP agent catalog)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores exactly what the Settings editor stores for the same authored agent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = createCatalogStore({ v: 2, backends: [] });
    const executor = createExecutor({ updateAccountAcpCatalogSettings: store.updateAccountAcpCatalogSettings } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('agents.acp.backends.upsert' as any, { backend: authored }, { surface: 'mcp' });

    const editorResult = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend: authored, nowMs: 1_000 });
    if (!editorResult.ok) throw new Error('expected the editor path to accept the agent');
    expect(store.read()).toEqual(editorResult.settings);
    expect(res).toEqual({ ok: true, result: { backend: editorResult.backend } });
  });

  it('returns the catalog owner\'s typed codes and writes nothing on a rejected change', async () => {
    const existing = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend: authored, nowMs: 1 });
    if (!existing.ok) throw new Error('fixture');
    const store = createCatalogStore(existing.settings);
    const executor = createExecutor({ updateAccountAcpCatalogSettings: store.updateAccountAcpCatalogSettings } as Partial<ActionExecutorDeps>);

    await expect(executor.execute('agents.acp.backends.upsert' as any, {
      backend: { ...authored, id: 'other-id' },
    }, { surface: 'mcp' })).resolves.toMatchObject({ ok: false, errorCode: 'acp_backend_name_conflict' });
    await expect(executor.execute('agents.acp.backends.delete' as any, { backendId: 'missing' }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'acp_backend_not_found' });
    expect(store.read()).toEqual(existing.settings);

    await expect(executor.execute('agents.acp.backends.delete' as any, { backendId: 'my-agent' }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { backendId: 'my-agent', deleted: true } });
    expect(store.read()).toEqual({ v: 2, backends: [] });
  });

  it('reports a host without an Account settings writer as unsupported', async () => {
    const executor = createExecutor();
    await expect(executor.execute('agents.acp.backends.delete' as any, { backendId: 'x' }, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});
