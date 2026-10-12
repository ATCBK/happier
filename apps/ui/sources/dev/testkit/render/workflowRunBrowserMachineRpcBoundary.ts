import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

import { createOrderedMachineRpcCaller as createProductionOrderedMachineRpcCaller } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.ts';

// Preserve real ordering while binding its supported transport dependency to the daemon boundary.
export function createOrderedMachineRpcCaller(call: typeof machineRpcWithServerScope = machineRpcWithServerScope) {
    return createProductionOrderedMachineRpcCaller(call);
}

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    const boundary = globalThis as typeof globalThis & {
        runBrowserMachineRpc: (request: Readonly<{ method: string; payload: unknown }>) => Promise<unknown>;
    };
    params.onDispatched?.();
    // The external daemon reply is deliberately untyped here; the real Action output schema validates it.
    return await boundary.runBrowserMachineRpc(params) as R;
}
