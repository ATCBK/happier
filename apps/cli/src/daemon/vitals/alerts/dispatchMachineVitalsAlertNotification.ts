import { MachineVitalsNotificationV1Schema, type MachineVitalsNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';
import type { MachineVitalsAlertTransitionV1 } from '@happier-dev/protocol/machines/vitals/evaluateMachineVitalsAlertsV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { LiveWorkInventoryV1 } from '@/daemon/lifecycle/managedActivity';

/** Background agents keep their owning Session working; references remain private. */
export function readMachineVitalsWorkingSessionCount(inventory: LiveWorkInventoryV1): number | undefined {
  if (inventory.coverage !== 'complete') return undefined;
  const owners = new Set<unknown>();
  for (const item of inventory.items) {
    if (item.category !== 'session' && item.category !== 'agents') continue;
    if (item.state === 'unknown' || item.ownerRef === null || item.ownerRef === undefined) return undefined;
    if (item.state === 'active') owners.add(item.ownerRef);
  }
  return owners.size;
}

export type MachineVitalsAlertNotificationInputV1 = Readonly<{
  transition: MachineVitalsAlertTransitionV1;
  latest: MachineVitalsSampleV1 | null;
  machineId: string;
  machineName?: string;
  workingSessionCount?: number;
  guardEnabled: boolean;
}>;
export type MachineVitalsAlertNotificationDispatchParamsV1 = MachineVitalsAlertNotificationInputV1
  & Omit<Parameters<typeof dispatchActivityNotificationAsync>[0], 'event'>;

/** Project the evaluator's witnessed window; never resample or infer unknown inventory. */
export function buildMachineVitalsAlertNotificationV1(input: MachineVitalsAlertNotificationInputV1): MachineVitalsNotificationV1 {
  const { episode, evidence } = input.transition;
  const common = { topic: 'resource_limit', phase: episode.state === 'fired' ? 'started' : 'recovered',
    machineId: input.machineId, ...(input.machineName ? { machineName: input.machineName } : {}),
    at: episode.at, since: input.transition.since, guardEnabled: input.guardEnabled,
    ...(input.workingSessionCount === undefined ? {} : { workingSessionCount: input.workingSessionCount }) };
  if (episode.rule === 'memory') {
    const swap = input.latest?.memory.reported ? input.latest.memory.swap : undefined;
    return MachineVitalsNotificationV1Schema.parse({ ...common, kind: 'memory_pressure', evidence: {
      ...evidence, ...(swap ? { swapTotalBytes: swap.totalBytes } : {}),
    } });
  }
  if (episode.rule === 'cpu') return MachineVitalsNotificationV1Schema.parse({ ...common, kind: 'cpu_busy', evidence });
  const volume = input.latest?.disk.reported ? input.latest.disk.volumes.find(volume => volume.id === episode.volumeId) : undefined;
  return MachineVitalsNotificationV1Schema.parse({ ...common, kind: 'disk_nearly_full', volumeId: episode.volumeId,
    ...(volume ? { volumeLabel: volume.label } : {}), evidence });
}

export async function dispatchMachineVitalsAlertNotificationAsync(input: MachineVitalsAlertNotificationDispatchParamsV1)
  : Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number }>> {
  const { transition, latest, machineId, machineName, workingSessionCount, guardEnabled, ...delivery } = input;
  const event = buildMachineVitalsAlertNotificationV1({ transition, latest, machineId, machineName, workingSessionCount, guardEnabled });
  return dispatchActivityNotificationAsync({ ...delivery, event });
}
