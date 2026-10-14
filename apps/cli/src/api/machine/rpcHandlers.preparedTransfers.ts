import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
  PreparedTransferRpcRequestV1Schema,
  PreparedTransferRpcResponseV1Schema,
  resolvePreparedTransferRpcPhaseV1,
  type PreparedTransferRpcRequestV1,
  type PreparedTransferRpcResponseV1,
} from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import type { RpcHandlerRegistrar } from '../rpc/types';

/** Home changes the carrier; the prepared HTTP owner retains capability and settlement admission. */
export function registerMachinePreparedTransferRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  request: (input: PreparedTransferRpcRequestV1) => Promise<PreparedTransferRpcResponseV1>;
}>): void {
  for (const method of [
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
  ]) {
    params.rpcHandlerManager.registerHandler(method, async (raw: unknown) => {
      const parsed = PreparedTransferRpcRequestV1Schema.safeParse(raw);
      if (!parsed.success || resolvePreparedTransferRpcPhaseV1(parsed.data.path, parsed.data.httpMethod, parsed.data.body) !== method) {
        return { error: 'Invalid prepared transfer phase', errorCode: 'invalid_request' };
      }
      return PreparedTransferRpcResponseV1Schema.parse(await params.request(parsed.data));
    });
  }
}
