import {
    DaemonNpmRegistryProfileMutationRequestV1Schema,
    DaemonNpmRegistryProfileMutationResponseV1Schema,
    DaemonNpmRegistryProfilesGetRequestV1Schema,
    DaemonNpmRegistryProfilesGetResponseV1Schema,
    isRpcMethodNotFoundResult,
    RPC_METHODS,
    type DaemonNpmRegistryProfileMutationRequestV1,
    type DaemonNpmRegistryProfileMutationResponseV1,
    type DaemonNpmRegistryProfilesGetResponseV1,
} from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type RpcOptions = Readonly<{
    serverId?: string | null;
    accountId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    onIssued?: () => void;
}>;

export type MachineNpmRegistryProfileMutationResult =
    | DaemonNpmRegistryProfileMutationResponseV1
    | Readonly<{ status: 'outcomeUnknown' }>;

export async function machineNpmRegistryProfilesGet(
    machineId: string,
    options: RpcOptions = {},
): Promise<DaemonNpmRegistryProfilesGetResponseV1> {
    const payload = DaemonNpmRegistryProfilesGetRequestV1Schema.parse({ machineId });
    options.assertCurrent?.();
    const response = await machineRpcWithServerScope<unknown, typeof payload>({
        machineId,
        serverId: options.serverId,
        accountId: options.accountId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET,
        payload,
    });
    if (isRpcMethodNotFoundResult(response)) return { status: 'error', code: 'unavailable', retryable: false };
    return DaemonNpmRegistryProfilesGetResponseV1Schema.parse(response);
}

export async function machineNpmRegistryProfilesMutate(
    machineId: string,
    request: DaemonNpmRegistryProfileMutationRequestV1,
    options: RpcOptions = {},
): Promise<MachineNpmRegistryProfileMutationResult> {
    const payload = DaemonNpmRegistryProfileMutationRequestV1Schema.parse({ ...request, machineId });
    options.assertCurrent?.();
    let issued = false;
    try {
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: options.serverId,
            accountId: options.accountId,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE,
            payload,
            preparePayload: () => { options.assertCurrent?.(); return payload; },
            onIssued: () => {
                options.assertCurrent?.();
                issued = true;
                options.onIssued?.();
            },
        });
        if (isRpcMethodNotFoundResult(response)) return { status: 'error', code: 'unavailable', retryable: false };
        const parsed = DaemonNpmRegistryProfileMutationResponseV1Schema.safeParse(response);
        if (!parsed.success) {
            if (issued) return { status: 'outcomeUnknown' };
            throw new Error('Invalid npm registry profile mutation response from daemon');
        }
        return parsed.data;
    } catch (error) {
        if (issued) return { status: 'outcomeUnknown' };
        throw error;
    }
}
