import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { ActionAccountContext, LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import {
    createUiAccountActionTransport,
    type AccountActionTransport,
    type UiAccountActionExecute,
} from './accountActionTransport';

/** The existing Account relay's serving machine; shared by its cold projection readers. */
export function resolveUiAccountActionFallbackMachineId(account: Pick<ActionAccountContext, 'serverId' | 'accountId'>): string | null {
    return areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, account.serverId)
        ? resolveVisibleMachinesForActiveServerFromState(storage.getState()).find((machine) => isMachineReachable(account, machine))?.id ?? null
        : null;
}

/** Compose the existing machine relay with the invocation's captured Account. */
export function createUiAccountAction(params: Readonly<{
    account: LazyActionAccountContext;
    transport?: AccountActionTransport;
}>): UiAccountActionExecute {
    const execute = createUiAccountActionTransport({
        account: params.account,
        resolveFallbackMachineId: () => resolveUiAccountActionFallbackMachineId(params.account),
        transport: params.transport ?? (async input => {
            const execution = await executeOriginalAccountMachineAction({ account: params.account, actionId: input.actionId,
                machineId: input.machineId, machineTarget: input.target, requestId: input.requestId, input: input.payload, invocation: input.invocation,
                ...(input.signal ? { signal: input.signal } : {}) });
            return execution.ok ? execution.result : execution;
        }),
    });
    return async (args) => await execute(
        args.context.serverId !== params.account.serverId
            && areServerProfileIdentifiersEquivalent(args.context.serverId, params.account.serverId)
            ? { ...args, context: { ...args.context, serverId: params.account.serverId } }
            : args,
    );
}
