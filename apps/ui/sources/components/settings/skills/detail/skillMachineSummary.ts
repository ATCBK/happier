import { t } from '@/text';

import type { SkillMachineTruth } from './useSkillMachineTruth';

/**
 * The closed line of "On your machines": who gets the skill, grouped by the Agents that do so a machine's
 * name is never repeated ("Claude, Codex on NLDW6"), and apart from it, how many machines are offline.
 */
export function summarizeMachines(
  shown: readonly SkillMachineTruth[],
  agentName: (agentId: string) => string,
): Readonly<{ summary: string; note: string | undefined }> {
  const online = shown.filter((entry) => entry.machine.online === true);
  const offline = shown.filter((entry) => entry.machine.offline).length;
  const groups = new Map<string, { agents: string[]; machines: string[] }>();
  let pending = false;
  for (const entry of online) {
    const delivered = entry.skillAgents.filter((agentId) => entry.facts.get(agentId)?.kind === 'delivered');
    if (entry.skillAgents.some((agentId) => (entry.facts.get(agentId) ?? { kind: 'pending' }).kind === 'pending')) pending = true;
    if (delivered.length === 0) continue;
    const key = delivered.join('\u0000');
    const group = groups.get(key) ?? { agents: delivered, machines: [] };
    group.machines.push(entry.machine.name ?? entry.machine.machineId);
    groups.set(key, group);
  }
  const clauses = [...groups.values()].map((group) => {
    const agents = group.agents.map(agentName).join(', ');
    return group.machines.length === 1
      ? t('capabilities.skillDetail.machines.summaryOn', { agents, machine: group.machines[0]! })
      : t('capabilities.skillDetail.machines.summaryOnMany', { agents, count: group.machines.length });
  });
  if (clauses.length === 0 && online.length > 0)
    clauses.push(t(pending ? 'capabilities.skillDetail.machines.checking' : 'capabilities.skillDetail.machines.nowhere'));
  if (clauses.length === 0 && shown.some(entry => entry.machine.online === null))
    clauses.push(t('common.unknown'));
  return {
    summary: clauses.join(' · '),
    note: offline > 0 ? t('capabilities.skillDetail.machines.offlineCount', { count: offline }) : undefined,
  };
}
