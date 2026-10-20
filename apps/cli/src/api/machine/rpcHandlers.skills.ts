import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { SKILL_MACHINE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { SKILL_ACTION_IDS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionIdsV1';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, type SkillMachineActionIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

/** Native discovery and opt-in installs share the daemon's admitted machine Action executor. */
export function registerMachineSkillsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  actionExecutor?: RpcActionExecutor<SkillMachineActionIdV1>;
}>): void {
  registerActionSpecRpcHandlers<SkillMachineActionIdV1>({ ...params, scopes: SKILL_MACHINE_RPC_SCOPES,
    actionIds: SKILL_ACTION_IDS_V1.filter((id): id is SkillMachineActionIdV1 => Object.hasOwn(SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, id)) });
}
