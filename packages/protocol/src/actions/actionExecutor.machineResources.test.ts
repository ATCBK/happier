import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';
import { RPC_METHODS } from '../rpc/methods.js';

describe('resources policy Action front door', () => {
  it('reads account metadata and uses the user-configurable agent approval policy for writes', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.get'), settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.set'), settings, { surface: 'agent' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('machines.resources.policy.set'), settings, { surface: 'ui' })).toBe(false);
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)).toMatchObject({ sharedMachineAccess: 'custodian_only' });
    const calls: unknown[] = [];
    // Boundary fixture supplies only the policy transport; unrelated Action transports are not invoked.
    const executor = createActionExecutor({ machineResourcesPolicyAction: async request => { calls.push(request.input); return { status: 'unavailable' }; } } as unknown as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('machines.resources.policy.get'), { machineId: 'machine' }, { surface: 'cli', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute(ActionIdSchema.parse('machines.resources.policy.get'), { machineId: 'machine', serverId: 'other' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(calls).toHaveLength(1);
  });
});
