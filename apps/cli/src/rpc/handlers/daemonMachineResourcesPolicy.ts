import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { MachineResourcesPolicySetInputV1Schema } from '@happier-dev/protocol/actions/specs/machineResources';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonMachineResourcesPolicyRoutes = Readonly<{
  policy: MachineResourcesPolicyRuntime;
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
}>;
export function registerDaemonMachineResourcesPolicyRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineResourcesPolicyRoutes): void {
  rpc.registerHandler(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineResourcesPolicySetInputV1Schema.parse(raw);
    const target = options.target();
    const matches = async () => {
      const current = options.target();
      const admission = context?.machineAdmission;
      return target && current && current.serverId === target.serverId
        && admission && admission.role === 'manage' && admission.actorAccountId === target.custodianAccountId
        && doesMachineRpcTargetMatchAdmission(request, admission, current);
    };
    const verify = async () => {
      return Boolean(await matches() && context?.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent() && await matches());
    };
    // The RPC owner already authenticated this admission. Read/normalize local
    // metadata first; the effect guard revalidates live authority immediately before CAS.
    if (!context?.verifyMachineAdmissionCurrent || !await matches()) throw new RpcError('Machine resources policy requires the custodian', RPC_ERROR_CODES.FORBIDDEN);
    return options.policy.set({ expectedRevision: request.expectedRevision, patch: request.patch }, { signal: context?.signal, verifyCurrent: verify });
  });
}
