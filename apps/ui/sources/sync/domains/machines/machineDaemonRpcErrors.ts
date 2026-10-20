import { isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

/** Home or daemon must affirm method absence; routing/discovery unavailability is temporary. */
export function isMachineDaemonRpcUnsupportedError(error: unknown): boolean {
    return isRpcMethodNotFoundError(error);
}
