import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { SKILL_MACHINE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';

/** Native discovery and opt-in installs share the daemon's admitted machine Action executor. */
export function registerMachineSkillsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  actionExecutor?: RpcActionExecutor;
}>): void {
  registerActionSpecRpcHandlers({ ...params, scopes: SKILL_MACHINE_RPC_SCOPES });
}
