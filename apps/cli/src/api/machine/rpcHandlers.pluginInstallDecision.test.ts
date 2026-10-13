import { describe, expect, it, vi } from 'vitest';

import {
  HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
} from '@happier-dev/protocol/marketplace/internal';

import { registerMachinePluginInstallDecisionRpcHandlers } from './rpcHandlers.pluginInstallDecision';
import type { PluginChangeDecision, PluginChangeDecisionResult } from '@/plugins/daemon/changeContract';

import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
      handlers.set(method, async raw => handler(raw as TRequest));
    },
  } satisfies RpcHandlerRegistrar & { handlers: Map<string, Handler> };
}

describe('rpcHandlers (plugin installation decision)', () => {
  it('passes UI-created present-user evidence through without minting or replacing it', async () => {
    const decideChange = vi.fn(async (decision: unknown) => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
      decision,
    }));
    const mgr = createRpcHandlerManager();
    registerMachinePluginInstallDecisionRpcHandlers({
      rpcHandlerManager: mgr,
      deps: {
        decidePluginChange: decideChange,
      },
    });

    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');
    await expect(decide?.({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.example' });
    expect(decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      optionalSelections: [{ accessId: 'workspace', selected: false }],
    });
  });


  it('requires the strict UI evidence shape and never treats a transport receipt as evidence', async () => {
    const decideChange = vi.fn();
    const mgr = createRpcHandlerManager();
    registerMachinePluginInstallDecisionRpcHandlers({
      rpcHandlerManager: mgr,
      deps: {
        decidePluginChange: decideChange,
      },
    });
    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');

    await expect(decide?.({
      v: 1,
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      optionalSelections: [],
      receipt: 'peer.rpc.direct_call_succeeded',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
    });
    expect(decideChange).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', { v: 1, pendingChangeId: 'pending-cancel', decision: 'cancel' }],
    ['expired', {
      v: 1,
      pendingChangeId: 'pending-expired',
      decision: 'installAndTrust',
      optionalSelections: [],
    }],
    ['conflict', {
      v: 1,
      pendingChangeId: 'pending-conflict',
      decision: 'installAndTrust',
      optionalSelections: [],
    }],
  ] as const)('passes through a %s daemon decision outcome', async (kind, request) => {
    const outcome: PluginChangeDecisionResult = kind === 'conflict'
      ? { kind, pluginId: 'acme.example' }
      : { kind };
    const decideChange = vi.fn(async (_decision: PluginChangeDecision): Promise<PluginChangeDecisionResult> => outcome);
    const mgr = createRpcHandlerManager();
    registerMachinePluginInstallDecisionRpcHandlers({
      rpcHandlerManager: mgr,
      deps: {
        decidePluginChange: decideChange,
      },
    });
    const decide = mgr.handlers.get(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD);
    expect(decide).toBeTypeOf('function');
    await expect(decide?.(request)).resolves.toEqual(outcome);
    if (request.decision === 'cancel') {
      expect(decideChange).toHaveBeenCalledWith({
        pendingChangeId: request.pendingChangeId,
        decision: 'cancel',
      });
    }
  });

});
