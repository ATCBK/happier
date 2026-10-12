import type { ReachRulesV1 } from './reachRuleV1.js';
import { resolveReachV1, type ReachDecisionV1 } from './resolveReachV1.js';

export type ReachProjectionV1 = readonly Readonly<{ machineId: string; agents: readonly Readonly<{ agentId: string } & ReachDecisionV1>[] }>[];
export function projectReachForMachinesV1(rules: ReachRulesV1, input: Readonly<{ machines: readonly Readonly<{
  machineId: string; platform: 'win32' | 'posix' | null; agentIds: readonly string[] }>[]; projectKey?: string | null }>): ReachProjectionV1 {
  return input.machines.map(machine => ({ machineId: machine.machineId, agents: machine.agentIds.map(agentId => ({ agentId,
    ...resolveReachV1(rules, { machineId: machine.machineId, machinePlatform: machine.platform, directory: null, projectKey: input.projectKey ?? null, agentId }),
  })) }));
}
