import {
    DaemonAgentInstallStartRequestSchema, DaemonAgentInstallStartResponseSchema,
    DaemonAgentInstallReadRequestSchema, DaemonAgentInstallReadResponseSchema,
    DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallCancelResponseSchema,
    DaemonAgentInstallListRequestSchema, DaemonAgentInstallListResponseSchema,
    type DaemonAgentInstallStartRequest, type DaemonAgentInstallReadRequest,
    type DaemonAgentInstallCancelRequest,
} from '@happier-dev/protocol/daemon/agent-install-jobs';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type AgentInstallJobRpcTarget = Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    signal?: AbortSignal;
}>;

export class AgentInstallJobRpcError extends RpcError {
    constructor(public readonly code: string, message = code) {
        // Preserve the RPC owner's typed refusal through the shared Action executor.
        super(message, code);
        this.name = 'AgentInstallJobRpcError';
    }
}

async function invoke<Request, Response>(
    target: AgentInstallJobRpcTarget,
    method: string,
    requestSchema: Readonly<{ parse(value: unknown): Request }>,
    responseSchema: Readonly<{ safeParse(value: unknown): { success: true; data: Response } | { success: false } }>,
    input: Request,
): Promise<Response> {
    const payload = requestSchema.parse(input);
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, Request>({ ...target, method, payload });
    } catch (error) {
        if (target.signal?.aborted) throw error;
        if (isRpcMethodNotFoundError(error)) throw new AgentInstallJobRpcError('unavailable');
        throw new AgentInstallJobRpcError('request_failed');
    }
    if (isRpcMethodNotFoundResult(raw)) {
        throw new AgentInstallJobRpcError('unavailable');
    }
    if (raw && typeof raw === 'object' && 'errorCode' in raw && isRpcMethodNotAvailableError({ rpcErrorCode: raw.errorCode })) {
        throw new AgentInstallJobRpcError('request_failed');
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new AgentInstallJobRpcError('invalid_response');
    return parsed.data;
}

export const startAgentInstallJobRpc = (target: AgentInstallJobRpcTarget, input: DaemonAgentInstallStartRequest) =>
    invoke(target, RPC_METHODS.DAEMON_AGENTS_INSTALL_START, DaemonAgentInstallStartRequestSchema, DaemonAgentInstallStartResponseSchema, input);
export const readAgentInstallJobRpc = (target: AgentInstallJobRpcTarget, input: DaemonAgentInstallReadRequest) =>
    invoke(target, RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallReadResponseSchema, input);
export const cancelAgentInstallJobRpc = (target: AgentInstallJobRpcTarget, input: DaemonAgentInstallCancelRequest) =>
    invoke(target, RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallCancelResponseSchema, input);
export const listAgentInstallJobsRpc = (target: AgentInstallJobRpcTarget) =>
    invoke(target, RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, DaemonAgentInstallListRequestSchema, DaemonAgentInstallListResponseSchema, {});
