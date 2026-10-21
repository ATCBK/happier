import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { ActionAccountContext, LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import {
    createUiAccountActionTransport,
    type AccountActionTransport,
    type UiAccountActionExecute,
} from './accountActionTransport';

/** The existing Account relay's serving machine; shared by its cold projection readers. */
export function resolveUiAccountActionFallbackMachineId(account: Pick<ActionAccountContext, 'serverId' | 'accountId'>,
    options?: Readonly<{
        candidateMachineIds?: readonly string[];
        target?: ActionExecutorContext['externalActionTarget'];
        /** Registry's user-triggered refresh retries its supplier after a failed request. */
        allowUnreachableFallback?: boolean;
    }>): string | null {
    if (!areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, account.serverId)) return null;
    const machines = resolveVisibleMachinesForActiveServerFromState(storage.getState(), account);
    const candidateMachineIds = options?.candidateMachineIds;
    const candidates = candidateMachineIds === undefined ? machines
        : machines.filter(machine => candidateMachineIds.includes(machine.id));
    const target = options?.target;
    if (target) return target.kind === 'machine'
        ? candidates.find(machine => machine.id === target.machineId)?.id ?? null : null;
    return candidates.find(machine => isMachineReachable(account, machine))?.id
        ?? (options?.allowUnreachableFallback ? candidates[0]?.id ?? null : null);
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
