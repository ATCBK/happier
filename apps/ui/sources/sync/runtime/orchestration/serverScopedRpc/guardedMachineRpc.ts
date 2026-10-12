import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resolveMachineRpcTargetServerId } from './resolveMachineRpcTargetServerId';

export { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';

export async function callGuardedMachineRpcWithPolicy<R, A>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    method: string;
    payload: A;
    requestId?: string;
    timeoutMs?: number;
    operationTimeoutMs?: null;
    signal?: AbortSignal;
    preferScoped?: boolean;
}>): Promise<R> {
    const targetServerId = resolveMachineRpcTargetServerId(params.serverId);

    return await machineRpcWithServerScope<R, A>({
        machineId: params.machineId,
        serverId: targetServerId,
        accountId: params.accountId ?? undefined,
        method: params.method,
        payload: params.payload,
        ...(params.requestId ? { requestId: params.requestId } : {}),
        timeoutMs: params.timeoutMs,
        ...(params.operationTimeoutMs === null ? { operationTimeoutMs: null } : {}),
        signal: params.signal,
        ...(params.preferScoped ? { preferScoped: true } : null),
    });
}
