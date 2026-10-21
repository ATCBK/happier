import { isMachineRpcTimeoutError } from '@happier-dev/protocol/rpcErrors';

export { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

/**
 * The Machine stopped answering: its typed RPC timeout, or an abort/timeout raised by a transport's own deadline.
 * A caller that aborted the operation itself checks its own signal first; this only names where the rest came from.
 */
export function isMachineStoppedAnsweringError(error: unknown): boolean {
    if (isMachineRpcTimeoutError(error)) return true;
    const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : null;
    return name === 'AbortError' || name === 'TimeoutError';
}
