import { afterAll, beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetchWithServerReachability, mockRelease, mockStorageState } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockResolveContext: vi.fn(),
  mockRuntimeFetchWithServerReachability: vi.fn(),
  mockRelease: vi.fn(async () => undefined),
  mockStorageState: {
    sessions: {},
    concurrentSessionListCacheByServerId: {},
    applySessions: vi.fn(),
  } as {
    sessions: Record<string, unknown>;
    concurrentSessionListCacheByServerId: Record<string, unknown>;
    applySessions: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('../../api/session/apiSocket', () => ({
  apiSocket: {
    request: mockRequest,
  },
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext', () => ({
  resolveServerAccountRequestContext: mockResolveContext,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: mockRuntimeFetchWithServerReachability,
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: vi.fn(async () => {
    throw new Error('Unexpected runtimeFetch call');
  }),
}));

vi.mock('../../domains/state/storage', () => ({
  storage: {
    getState: () => mockStorageState,
  },
}));

import { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } from '../../ops';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    headers: new Map(),
  } as any;
}

describe('sessionArchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetchWithServerReachability.mockReset();
    mockRelease.mockClear();
    mockStorageState.sessions = {};
    mockStorageState.concurrentSessionListCacheByServerId = {};
    mockStorageState.applySessions.mockReset();
  });

  it('uses active apiSocket.request when scope is active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 10 } }));

    const res = await sessionArchiveWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true, archivedAt: 10 });
    expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/archive', { method: 'POST' });
    expect(mockRuntimeFetchWithServerReachability).not.toHaveBeenCalled();
  });

  it('uses runtimeFetchWithServerReachability with the scoped server URL and bearer token when scope is not active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'scoped',
      targetServerUrl: 'https://scoped.example',
      runtimeOrigin: 'http://127.0.0.1:49152',
      carrier: 'iroh',
      targetServerId: 'server-b',
      token: 'tok_scoped',
      timeoutMs: 1000,
      encryption: null,
      release: mockRelease,
    });
    mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: 11 } }));

    const res = await sessionArchiveWithServerScope('sid-2', { serverId: 'server-b' });
    expect(res).toEqual({ success: true, archivedAt: 11 });
    expect(mockRuntimeFetchWithServerReachability).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://scoped.example',
        token: 'tok_scoped',
        url: 'http://127.0.0.1:49152/v2/sessions/sid-2/archive',
        runtimeOrigin: 'http://127.0.0.1:49152',
        timeoutMs: 1000,
        init: expect.objectContaining({
          method: 'POST',
        }),
      }),
    );
    expect(new Headers(mockRuntimeFetchWithServerReachability.mock.calls[0]?.[0]?.init?.headers).get('Authorization'))
      .toBe('Bearer tok_scoped');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('surfaces a stable session_active code for JSON archive conflicts', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({
      ok: false,
      status: 409,
      text: '{"error":"session-active"}',
    }));

    const res = await sessionArchiveWithServerScope('sid-conflict', { serverId: 'server-a' });

    expect(res).toEqual({
      success: false,
      message: 'Cannot archive an active session',
      code: 'session_active',
    });
  });
});

describe('archive routing from canonical session-list rows', () => {
  let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;

  beforeAll(async () => {
    vi.doUnmock('@/sync/api/session/apiSocket');
    vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext');
    vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
    vi.doUnmock('@/utils/system/runtimeFetch');
    vi.doUnmock('@/sync/domains/state/storage');
    vi.resetModules();
    boundary = await (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')).installSessionOpsNetworkBoundary();
  });

  afterAll(async () => {
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    await boundary?.dispose();
  });

  it.each(['archive', 'unarchive'] as const)('projects a remote %s only into the captured Home, including list-only rows', async action => {
    const owner = await boundary.addHome('https://projection-owner.example', 'projection-owner');
    const other = await boundary.addHome('https://projection-other.example', 'projection-other');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionFixture, createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } = await import('../sessions');
    storage.setState(storage.getInitialState(), true);
    const before = action === 'archive' ? null : 10;
    const after = action === 'archive' ? 42 : null;
    const active = createSessionFixture({ id: 'same-session', serverId: other.id, archivedAt: before });
    storage.setState({ sessions: { [active.id]: active } });
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: active.id, archivedAt: before }),
    ], { source: action === 'archive' ? 'ordinary' : 'archived', mode: 'replace' });
    storage.getState().applyServerScopedSessionListRows(other.id, [
      createSessionListRenderableSessionFixture({ id: active.id, archivedAt: before }),
    ], { source: 'ordinary', mode: 'replace' });
    const unrelated = storage.getState().sessionListRowsByServerId[other.id];
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${active.id}/${action}`
      ? Response.json({ success: true, archivedAt: after }) : null);
    const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
    await expect(run(active.id, { serverId: owner.id })).resolves.toMatchObject({ success: true });
    expect(storage.getState().sessions[active.id]).toBe(active);
    expect(storage.getState().sessionListRowsByServerId[other.id]).toBe(unrelated);
    expect(storage.getState().sessionListRowsByServerId[owner.id]?.[active.id]?.archivedAt).toBe(after);
    expect(action === 'archive' ? storage.getState().archivedSessionListMembershipByServerId[owner.id]
      : storage.getState().ordinarySessionListMembershipByServerId[owner.id]).toContain(active.id);
  });

  it.each(['archive', 'unarchive'] as const)('projects a remote %s through Home identity discovery while HTTP is pending', async action => {
    const owner = await boundary.addHome(`https://discovered-${action}.example`, `discovered-${action}`);
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { setServerProfileIdentityForUrl, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
    const { readSessionListRowForServerId } = await import('@/sync/domains/session/listing/sessionListRowStateLookup');
    const { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } = await import('../sessions');
    storage.setState(storage.getInitialState(), true);
    const before = action === 'archive' ? null : 10;
    const after = action === 'archive' ? 42 : null;
    const sessionId = `discovered-${action}`;
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: sessionId, archivedAt: before }),
    ], { source: action === 'archive' ? 'ordinary' : 'archived', mode: 'replace' });
    let releaseResponse!: () => void;
    let enterRequest!: () => void;
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    const requestEntered = new Promise<void>(resolve => { enterRequest = resolve; });
    boundary.setHttpResponder(async input => {
      if (new URL(String(input)).pathname !== `/v2/sessions/${sessionId}/${action}`) return null;
      enterRequest();
      await responseReady;
      return Response.json({ success: true, archivedAt: after });
    });
    const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
    const pending = run(sessionId, { serverId: owner.id });
    const canonicalId = `srv_discovered_${action}`;
    try {
      await requestEntered;
      await setServerProfileIdentityForUrl(owner.serverUrl, canonicalId);
      expect(readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, canonicalId, sessionId)?.archivedAt).toBe(before);
    } finally {
      releaseResponse();
    }
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, canonicalId, sessionId)?.archivedAt).toBe(after);
    const memberships = action === 'archive' ? storage.getState().archivedSessionListMembershipByServerId
      : storage.getState().ordinarySessionListMembershipByServerId;
    expect(Object.entries(memberships).filter(([serverId]) => areServerProfileIdentifiersEquivalent(serverId, canonicalId))
      .flatMap(([, ids]) => ids ?? [])).toContain(sessionId);
  });

  it('defaults a null serverId to the preferred owner Home from its canonical local list', async () => {
    const owner = await boundary.addHome('https://archive-owner.example', 'archive-account');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    storage.setState(storage.getInitialState(), true);
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: 'sid-owned' }),
    ], { source: 'ordinary', mode: 'replace' });
    boundary.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v2/sessions/sid-owned/archive'
      ? Response.json({ success: true, archivedAt: 12 }) : null);
    const { sessionArchiveWithServerScope: archive } = await import('../sessions');

    await expect(archive('sid-owned', { serverId: null })).resolves.toEqual({ success: true, archivedAt: 12 });
    expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive'))).toEqual([
      { url: `${owner.serverUrl}/v2/sessions/sid-owned/archive`, token: `Bearer ${owner.token}` },
    ]);
  });
});

describe('sessionUnarchiveWithServerScope', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockResolveContext.mockReset();
    mockRuntimeFetchWithServerReachability.mockReset();
  });

  it('uses active apiSocket.request when scope is active', async () => {
    mockResolveContext.mockResolvedValue({
      scope: 'active',
      targetServerUrl: 'https://active.example',
      targetServerId: 'server-a',
      token: 'tok',
      timeoutMs: 1000,
      encryption: null,
    });
    mockRequest.mockResolvedValue(makeResponse({ ok: true, json: { success: true, archivedAt: null } }));

    const res = await sessionUnarchiveWithServerScope('sid-1', { serverId: 'server-a' });
    expect(res).toEqual({ success: true, archivedAt: null });
    expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/unarchive', { method: 'POST' });
    expect(mockRuntimeFetchWithServerReachability).not.toHaveBeenCalled();
  });
});
