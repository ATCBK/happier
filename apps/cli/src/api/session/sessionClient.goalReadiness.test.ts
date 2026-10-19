import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ApiSessionClient } from './sessionClient';

// Socket transports are the external boundary. Keep the Session's runtime
// registration, controls installation, and RPC dispatch real.
vi.mock('./sockets', () => ({ createUserScopedSocket: () => createApiSessionSocketStub({ connected: true }) }));
vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    const socket = createApiSessionSocketStub({ connected: true });
    return {
      socket,
      transport: {
        connect: async () => {}, disconnect: async () => {}, destroy: async () => {},
        isConnected: () => socket.connected,
        onConnected: () => () => {}, onDisconnected: () => () => {}, onError: () => () => {},
      },
    };
  },
}));

describe('Session Goal runtime readiness', () => {
  const clients: ApiSessionClient[] = [];
  function createClient() {
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'resumed-goal' }));
    clients.push(client);
    return client;
  }
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.setSessionRuntimeControls(null);
      await client.close();
    }
  });

  it.each([
    [SESSION_RPC_METHODS.SESSION_GOAL_SET, { objective: 'Finish the resumed work' }],
    [SESSION_RPC_METHODS.SESSION_GOAL_GET, {}],
    [SESSION_RPC_METHODS.SESSION_GOAL_CLEAR, {}],
  ])('joins initial runtime control installation before answering %s', async (method, request) => {
    const client = createClient();
    let settled = false;
    const reply = client.rpcHandlerManager.invokeLocal(method, request).then(result => {
      settled = true;
      return result;
    });
    // Session identity and its RPC registry exist before native open completes.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    client.setSessionRuntimeControls({ refreshGoal: () => undefined, setGoal: () => undefined, clearGoal: () => undefined });
    await expect(reply).resolves.toEqual({ workState: null });
  });

  it('returns unsupported once control installation declares no native Goal support', async () => {
    const client = createClient();
    const pending = client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_SET, { objective: 'Finish' });
    await new Promise<void>(resolve => setImmediate(resolve));
    client.setSessionRuntimeControls({});
    await expect(pending)
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
    client.setSessionRuntimeControls(null);
    await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR, {}))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
  });

  it('settles a waiting Goal when its Session closes before runtime installation', async () => {
    const client = createClient();
    const reply = client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {});
    await new Promise<void>(resolve => setImmediate(resolve));
    await client.close();
    await expect(reply).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
  });

  it('cancels a pending Goal without applying it after installation', async () => {
    const client = createClient();
    const controller = new AbortController();
    const objectives: (string | undefined)[] = [];
    const reply = client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_SET,
      { objective: 'Cancelled objective' }, { signal: controller.signal });
    const outcome = reply.catch((error: unknown) => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    client.setSessionRuntimeControls({ setGoal: objective => { objectives.push(objective); } });
    expect(objectives).toEqual([]);
  });
});
