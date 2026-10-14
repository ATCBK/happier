import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';

const boundary = vi.hoisted(() => ({
  execute: vi.fn(),
  open: vi.fn(async () => true),
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// The mounted Action front door and the system browser are the boundaries; the sign-in state runs for real.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
  useMountedActionExecution: () => ({
    execute: boundary.execute,
    ready: true,
    isCurrent: () => true,
    approval: {},
  }),
}));
vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: boundary.open,
}));

const { useMcpServerSignIn } = await import('./useMcpServerSignIn');

const server = {
  id: 'linear',
  name: 'Linear',
  transport: 'http',
  env: {},
  createdAt: 1,
  updatedAt: 1,
  remote: {
    url: 'https://mcp.linear.app/mcp',
    headers: {},
    auth: { kind: 'oauth' },
  },
} as unknown as McpServerCatalogEntryV1;
const online = [{ machineId: 'm1', name: 'nl2', online: true }];
const offline = [{ machineId: 'm1', name: 'nl2', online: false }];
const started = {
  attemptId: 'attempt-1',
  authorizationUrl: 'https://linear.app/oauth/authorize?state=attempt-1.n',
  expiresAtMs: Date.now() + 600_000,
  machineId: 'm1',
};

function grant(
  status: 'connected' | 'needs_reauth',
  credentialRevision: number,
) {
  return {
    ref: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: 'linear' },
    status,
    authenticationModeId: 'oauth',
    configurationReady: true,
    configurationRevision: 1,
    kind: 'oauth',
    revisionSemantics: 'revisioned',
    credentialRevision,
    providerIdentity: { email: 'leeroy@acme.dev' },
    scopes: ['read', 'write'],
  };
}
function setGrants(grants: readonly unknown[]) {
  const state = getStorage().getState();
  getStorage().setState({
    profile: { ...state.profile, connectedAccountsV4: grants },
  } as never);
}

beforeEach(() => {
  boundary.execute.mockReset();
  boundary.open.mockClear();
  getStorage().setState({
    settingsScope: { serverId: 'home', accountId: 'account' },
  } as never);
  setGrants([]);
});
afterEach(async () => {
  await standardCleanup();
});

describe('useMcpServerSignIn', () => {
  it('signs in: opens the browser, waits, and becomes Connected when the grant lands', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    expect(hook.getCurrent().view).toEqual({ state: 'not_connected' });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.signIn.start', {
      serverId: 'linear',
    });
    expect(boundary.open).toHaveBeenCalledWith(started.authorizationUrl);
    expect(hook.getCurrent().view).toMatchObject({
      state: 'signing',
      authorizationUrl: started.authorizationUrl,
    });
    expect(hook.getCurrent().fact).toEqual({ state: 'signing' });
    await act(async () => {
      setGrants([grant('connected', 1)]);
    });
    expect(hook.getCurrent().view).toEqual({
      state: 'connected',
      identity: 'leeroy@acme.dev',
      scopes: ['read', 'write'],
      lastUsedAt: null,
    });
  });

  it('a pasted answer finishes on the attempt machine; a refusal says it did not finish', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => {
      await hook.getCurrent().start();
    });
    boundary.execute.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'rejected',
        attemptId: 'attempt-1',
        code: 'invalid_grant',
      },
    });
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await hook
        .getCurrent()
        .complete({
          code: 'c',
          state: 'attempt-1.n',
          iss: 'https://linear.app',
        });
    });
    expect(boundary.execute).toHaveBeenLastCalledWith(
      'connectedServices.authentication.completeOAuth',
      expect.objectContaining({
        machineId: 'm1',
        attemptId: 'attempt-1',
        completion: expect.objectContaining({
          code: 'c',
          iss: 'https://linear.app',
        }),
      }),
      expect.anything(),
    );
    expect(accepted).toBe(false);
    expect(hook.getCurrent().view).toEqual({ state: 'did_not_finish' });
  });

  it('cancel reverses the attempt on its machine and returns to Not connected', async () => {
    boundary.execute.mockResolvedValueOnce({ ok: true, result: started });
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    await act(async () => {
      await hook.getCurrent().start();
    });
    boundary.execute.mockResolvedValueOnce({
      ok: true,
      result: { status: 'cancelled', attemptId: 'attempt-1' },
    });
    await act(async () => {
      await hook.getCurrent().cancel();
    });
    expect(boundary.execute).toHaveBeenLastCalledWith(
      'connectedServices.authentication.cancel',
      { machineId: 'm1', attemptId: 'attempt-1' },
      expect.anything(),
    );
    expect(hook.getCurrent().view).toEqual({ state: 'not_connected' });
  });

  it('no machine online is said (and disables Sign in); an explicit retry still asks', async () => {
    const hook = await renderHook(() => useMcpServerSignIn(server, offline));
    expect(hook.getCurrent().view).toEqual({ state: 'no_machine_online' });
    boundary.execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'no_machine_online',
      error: 'no_machine_online',
    });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.signIn.start', {
      serverId: 'linear',
    });
    expect(hook.getCurrent().view).toEqual({ state: 'no_machine_online' });
  });

  it('reads expired and refused sign-ins, and a server without OAuth never speaks', async () => {
    setGrants([grant('needs_reauth', 1)]);
    const hook = await renderHook(() => useMcpServerSignIn(server, online));
    expect(hook.getCurrent().view).toEqual({
      state: 'expired',
      reason: 'expired',
    });
    boundary.execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'client_refused',
      error: 'client_refused',
    });
    await act(async () => {
      await hook.getCurrent().start();
    });
    expect(hook.getCurrent().view).toEqual({ state: 'client_refused' });
    const local = await renderHook(() =>
      useMcpServerSignIn(
        { ...server, transport: 'stdio', remote: undefined } as never,
        online,
      ),
    );
    expect(local.getCurrent().view).toBeNull();
    expect(local.getCurrent().fact).toBeNull();
  });
});
