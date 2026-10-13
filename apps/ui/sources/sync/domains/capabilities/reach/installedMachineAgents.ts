import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';

/** Shared passive read for reach and Action facts; it never starts a probe. */
export function readInstalledMachineAgentIds(
  published: MachinePublishedMetadataV1['agentInventory'],
  cached: MachineAgentsSnapshot | undefined,
): readonly string[] {
  if (published) return published.installedAgentIds;
  // Retained metadata from a daemon without publication can use this device's last-known facts.
  return (cached?.agents ?? []).filter(agent => agent.installed).map(agent => agent.agentId);
}
