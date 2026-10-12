import { isWorkspacePathWithinRootV1, normalizeWorkspaceRootPathV1 } from '../workspaces/workspaceRefResolutionV1.js';
import type { ReachPlaceV1 } from './reachPlaceV1.js';
import type { ReachRuleV1 } from './reachRuleV1.js';

export type ReachContextV1 = Readonly<{ machineId: string; machinePlatform: 'win32' | 'posix' | null;
  directory: string | null; projectKey: string | null; agentId: string | null }>;
export type ReachDecisionV1 = Readonly<{ enabled: boolean;
  decidedBy: Readonly<{ ruleId: string; target: ReachPlaceV1['t']; agentQualified: boolean }> | null }>;

export function isReachPlaceApplicableV1(target: ReachPlaceV1, context: ReachContextV1): boolean {
  if (target.t === 'allMachines') return true;
  if (target.t === 'project') return target.projectKey === context.projectKey;
  if (target.machineId !== context.machineId) return false;
  return target.t === 'machine' || context.directory !== null
    && isWorkspacePathWithinRootV1(context.directory, target.workspaceRoot, context.machinePlatform);
}

const placeRanks = { allMachines: 1, machine: 2, project: 3, workspace: 4 } as const;

/** Retains the predecessor timestamp and ascending-id tie break. */
export function compareReachRulesV1(left: ReachRuleV1, right: ReachRuleV1, platform?: ReachContextV1['machinePlatform']): number {
  const rootLength = (rule: ReachRuleV1) => rule.target.t === 'workspace'
    ? (normalizeWorkspaceRootPathV1(rule.target.workspaceRoot, platform)?.length ?? 0) : 0;
  return Number(left.agentId !== undefined) - Number(right.agentId !== undefined)
    || placeRanks[left.target.t] - placeRanks[right.target.t]
    || rootLength(left) - rootLength(right)
    || left.updatedAt - right.updatedAt || left.createdAt - right.createdAt || right.id.localeCompare(left.id);
}

export function resolveReachV1(rules: readonly ReachRuleV1[], context: ReachContextV1): ReachDecisionV1 {
  let winner: ReachRuleV1 | null = null;
  for (const rule of rules) {
    if (rule.agentId !== undefined && rule.agentId !== context.agentId || !isReachPlaceApplicableV1(rule.target, context)) continue;
    if (!winner || compareReachRulesV1(rule, winner, context.machinePlatform) > 0) winner = rule;
  }
  return { enabled: winner?.enabled ?? false, decidedBy: winner ? { ruleId: winner.id, target: winner.target.t, agentQualified: winner.agentId !== undefined } : null };
}

export function isReachPortableV1(rules: readonly ReachRuleV1[]): boolean {
  return rules.some(rule => rule.target.t === 'allMachines' || rule.target.t === 'project');
}
