import { isGuardActionEntry, type MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { MachineGuardActivityNotificationV1Schema, type MachineGuardActivityNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';

export function buildMachineGuardEpisodeNotificationEvent(input: Readonly<{
  machineId: string;
  episode: Readonly<{ episodeId: string; freedBytes: number; outOfSteps: boolean;
    entries: readonly MachineGuardActivityEntryV1[] }>;
}>): MachineGuardActivityNotificationV1 {
  const counts = { stoppedSessions: 0, closedBrowsers: 0, stoppedServices: 0, stoppedLeftBehind: 0 };
  for (const entry of input.episode.entries) {
    if (!isGuardActionEntry(entry)) continue;
    switch (entry.kind) {
      case 'stopped_session': counts.stoppedSessions += 1; break;
      case 'closed_browser': counts.closedBrowsers += 1; break;
      case 'stopped_service': counts.stoppedServices += 1; break;
      case 'stopped_left_behind': counts.stoppedLeftBehind += 1; break;
    }
  }
  return MachineGuardActivityNotificationV1Schema.parse({
    topic: 'machine_guard_activity', machineId: input.machineId, episodeId: input.episode.episodeId,
    freedBytes: input.episode.freedBytes, outOfSteps: input.episode.outOfSteps, counts,
  });
}
