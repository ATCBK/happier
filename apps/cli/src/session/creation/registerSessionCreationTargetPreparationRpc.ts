import { SessionCreationTargetPreparationRequestV1Schema, needsSessionCreationDirectoryApprovalPreflightV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

import { prepareSessionCreationTarget } from './prepareSessionCreationTarget';

type PrepareSessionCreationTarget = typeof prepareSessionCreationTarget;

export function registerSessionCreationTargetPreparationRpc(input: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  prepare?: PrepareSessionCreationTarget;
}>): void {
  const prepare = input.prepare ?? prepareSessionCreationTarget;
  const prepareRequest = async (rawRequest: unknown, context: RpcHandlerContext | undefined,
    readOnly: boolean): Promise<SessionCreationTargetPreparationResultV1> => {
    if (!context) {
      throw new Error('Session creation target preparation requires an RPC cancellation context');
    }
    const request = SessionCreationTargetPreparationRequestV1Schema.parse(rawRequest);
    // This method is read-only for every caller. The original materializing
    // method keeps its custodian-only admission, including on older guests.
    if (readOnly && !needsSessionCreationDirectoryApprovalPreflightV1(request)) {
      throw createRpcCallError({ error: 'Directory preflight is read-only', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    return await prepare({ request, signal: context.signal });
  };
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
    (request, context) => prepareRequest(request, context, false));
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
    (request, context) => prepareRequest(request, context, true));
}
