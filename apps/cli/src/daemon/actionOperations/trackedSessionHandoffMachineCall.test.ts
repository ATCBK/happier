import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildTrackedSessionHandoffMachineCall } from './trackedSessionHandoffMachineCall';

describe('buildTrackedSessionHandoffMachineCall', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows the target resume RPC to outlive the transport default without widening other handoff calls', () => {
    vi.stubEnv('HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS', '420000');
    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: { sessionId: 'session-1' },
    })).toEqual({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: { sessionId: 'session-1' },
      timeoutMs: 420_000,
    });

    expect(buildTrackedSessionHandoffMachineCall({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
      request: { sessionId: 'session-1' },
    })).toEqual({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
      request: { sessionId: 'session-1' },
    });
  });
});
