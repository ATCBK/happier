import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

export function createUiUsageSourceActionPort(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'assertCurrent'>
  & Partial<Pick<LazyActionAccountContext, 'accountLifetime' | 'invocationSignal'>>,
  dismiss?: Parameters<typeof createUsageSourceActionPort>[0]['dismiss'],
): NonNullable<ActionExecutorDeps['usageSourceAction']> {
  return createUsageSourceActionPort({
    serverId: account.serverId,
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    rpc: (request, context) => withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope({
      serverId: account.serverId, accountId: account.accountId, machineId: request.input.machineId,
      method: request.actionId, payload: request.input, signal, preferScoped: true,
      onDispatched: () => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    })),
    ...(dismiss ? { dismiss } : {}),
  });
}
