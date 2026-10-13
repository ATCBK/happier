import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type WorkspaceFileRpcErrorCode = 'method_unavailable' | 'transport_failed';

/** Client transport projection shared by workspace filename and content adapters. */
export function classifyWorkspaceFileRpcError(error: unknown): WorkspaceFileRpcErrorCode {
    const code = readRpcErrorCode(error);
    return code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || code === RPC_ERROR_CODES.METHOD_NOT_FOUND
        || code === RPC_ERROR_CODES.UPDATE_REQUIRED
        ? 'method_unavailable' : 'transport_failed';
}
