import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DetectCliSnapshot } from './cliSnapshot';

/** Project the existing detector's facts without publishing paths, dependencies or authentication. */
export function projectMachineAgentInventoryFromCliSnapshot(input: Readonly<{
  snapshot: DetectCliSnapshot;
  checkedAt: number;
  current?: MachinePublishedMetadataV1['agentInventory'];
  observedAgentIds?: readonly string[];
}>): NonNullable<MachinePublishedMetadataV1['agentInventory']> {
  const previous = new Set(input.current?.installedAgentIds ?? []);
  const installed = new Set(input.observedAgentIds ? previous : []);
  for (const agentId of input.observedAgentIds ?? Object.keys(input.snapshot.clis)) {
    const fact = input.snapshot.clis[agentId];
    if (!fact || fact.detectionError || fact.installed === undefined) {
      if (previous.has(agentId)) installed.add(agentId);
    } else if (fact.installed === true) installed.add(agentId);
    else installed.delete(agentId);
  }
  return { checkedAt: input.checkedAt, installedAgentIds: [...installed].sort() };
}
