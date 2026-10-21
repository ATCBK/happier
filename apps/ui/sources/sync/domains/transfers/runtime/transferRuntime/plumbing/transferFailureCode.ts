import { isMachineStoppedAnsweringError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';

/**
 * The typed code a thrown transfer error keeps when a layer flattens it into a failure response: its own, else the
 * Machine timeout for an abort or deadline, so a caller can word "isn't answering" instead of the transport's text.
 */
export function readTransferFailureCode(error: unknown): string | undefined {
    if (error && typeof error === 'object' && typeof (error as { errorCode?: unknown }).errorCode === 'string') {
        return (error as { errorCode: string }).errorCode;
    }
    return isMachineStoppedAnsweringError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : undefined;
}
