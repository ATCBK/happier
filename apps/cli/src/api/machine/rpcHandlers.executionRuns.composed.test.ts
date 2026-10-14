import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { registerMachineRpcHandlers } from './rpcHandlers';

describe('detached execution-run Machine composition', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads through the installed Machine transport without reopening network admission', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-detached', encryptionMode: 'plain' });
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: rpc,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: { currentMachineId: 'machine-detached' },
    });
    // HTTP is a genuine system boundary. Already admitted local controls keep
    // their installed transport when network admission is unavailable.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('network unavailable'));
    const deps = createCliActionDeps({
      sessionId: 'cli-global', token: 'token', mode: 'plain', ctx: null,
      credentials: { token: 'token', encryption: null },
      machineActionDirectTargetTransport: {
        machineId: 'machine-detached',
        invoke: (method, request, options) => rpc.invokeLocal(method, request, options),
      },
    });
    try {
      const options = { exactMachineId: 'machine-detached' };
      const listed = await deps.executionRunList(null, { limit: 3 }, options);
      expect(getActionSpec('execution.run.list').outputSchema.parse(listed)).toEqual({ runs: [] });
      await expect(deps.executionRunGet(null, { runId: 'missing-run' }, options))
        .resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    } finally {
      await registration.dispose();
    }
  });
});
