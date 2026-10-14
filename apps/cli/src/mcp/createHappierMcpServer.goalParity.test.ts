import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from './createHappierMcpServer';

describe('createHappierMcpServer goal parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes Claude runner goal tools through the bound live Session RPC', async () => {
    const sessionId = 'claude-live-goal-session';
    const metadata = createTestMetadata({ flavor: 'claude', machineId: 'machine-1', path: '/repo' });
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const setGoal = vi.fn(async (raw: unknown) => ({
      ok: true,
      workState: {
        v: 1,
        items: [{ id: 'goal:claude', kind: 'goal', status: 'active', title: (raw as { objective: string }).objective, updatedAt: 1 }],
        primaryItemId: 'goal:claude',
      },
    }));
    rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_SET, setGoal);
    const session = {
      sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => metadata,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getPermissionMode: () => 'default',
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId: string) => turnId === 'goal-turn' ? 0 : undefined,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'goal-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      }),
    };
    const runtime = createHappierMcpServer(session, {
      credentials: { token: 'claude-goal-account', encryption: null },
      accountSettings: accountSettingsParse({}),
    });
    try {
      const dedicated = await runtime.executeTool({
        toolName: 'session_goal_set',
        args: { objective: 'Ship dedicated goal parity' },
      });
      const generic = await runtime.executeTool({
        toolName: 'action_execute',
        args: { actionId: 'session.goal.set', input: { objective: 'Ship generic goal parity' } },
      });

      if (!dedicated.ok) throw new Error(JSON.stringify(dedicated));
      expect(generic).toMatchObject({ ok: true });
      expect(setGoal).toHaveBeenNthCalledWith(1, expect.objectContaining({ objective: 'Ship dedicated goal parity' }), expect.anything());
      expect(setGoal).toHaveBeenNthCalledWith(2, expect.objectContaining({ objective: 'Ship generic goal parity' }), expect.anything());
    } finally {
      await runtime.mcp.close();
    }
  });
});
