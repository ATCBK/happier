import { dirname } from 'node:path';

import type { FilesystemActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import { resolveFilesystemTargetPath } from './accessPolicy/filesystemPathAuthorization';
import { resolveFilesystemMutationActionExecutor, type FilesystemMutationActionIngress } from './pathMutationHandlers';

/** Translate predecessor path-only carriers without replacing an explicit checkout root. */
export function registerRootedFilesystemRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  workingDirectory: string;
  actionIds: readonly FilesystemActionId[];
  actionExecutor?: RpcActionExecutor;
  incumbentExecutor: RpcActionExecutor;
  mutationIngress?: FilesystemMutationActionIngress;
}>): void {
  const isRootless = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input) && !Object.hasOwn(input, 'rootPath');

  registerActionSpecRpcHandlers<FilesystemActionId>({
    rpcHandlerManager: params.rpcHandlerManager,
    actionIds: params.actionIds,
    actionExecutor: params.actionExecutor,
    ...(params.mutationIngress?.mutationMachineId ? {
      targetMachineId: params.mutationIngress.mutationMachineId, defaultMachineTarget: true,
    } : {}),
    resolveActionExecutor: request => {
      const incumbentExecutor: RpcActionExecutor = isRootless(request.input) ? {
        // The incumbent owner retains policy-scoped reads and exact transient-file
        // grants. A receiving requester executor still owns its full Action admission.
        execute: (actionId, _mapped, context) => params.incumbentExecutor.execute(actionId, request.input, context),
      } : params.incumbentExecutor;
      return params.mutationIngress
        ? resolveFilesystemMutationActionExecutor(params.mutationIngress, request, incumbentExecutor)
        : incumbentExecutor;
    },
    mapRequestForMethod: ({ actionId, method, isAlias, input }) => {
      if ((!isAlias && method !== RPC_METHODS.LIST_DIRECTORY) || !isRootless(input)) return { accepted: true, input };
      const path = resolveFilesystemTargetPath({ targetPath: input.path, defaultDirectory: params.workingDirectory });
      if (!path.valid) return { accepted: true, input };
      // The old request already names the complete read/write extent. Its
      // containing directory is a strict current carrier, not another authority.
      const rootPath = actionId === 'daemon.filesystem.readFile' || actionId === 'daemon.filesystem.writeFile'
        ? dirname(path.resolvedPath) : path.resolvedPath;
      return { accepted: true, input: { ...input, rootPath, path: path.resolvedPath } };
    },
  });
}
