import type { MachineVitalsAlertsPolicyV1 } from './machineVitalsAlertsV1.js';
import type { MachineVitalsAlertEpisodeV1, MachineVitalsMinuteRecordV1 } from './machineVitalsHistoryV1.js';
import type { MachineVitalsSampleV1 } from './machineVitalsSampleV1.js';
import { isSustainedV1 } from './isSustainedV1.js';
import { resolveMachineDiskAttentionKindV1 } from './machineVitalsAttentionV1.js';

export type MachineVitalsAlertTransitionV1 = Readonly<{
  episode: MachineVitalsAlertEpisodeV1;
  since: number;
  evidence: { level: 'elevated' | 'critical'; sustainMs: number; swapUsedBytes?: number }
    | { abovePct: number; sustainMs: number; busyPct: number }
    | { freeBytes: number; totalBytes: number; threshold: MachineVitalsAlertsPolicyV1['disk']['threshold'] };
}>;
export function evaluateMachineVitalsAlertsV1(input: Readonly<{
  policy: MachineVitalsAlertsPolicyV1;
  records: readonly MachineVitalsMinuteRecordV1[];
  episodes: readonly MachineVitalsAlertEpisodeV1[];
  now: number;
  disk?: MachineVitalsSampleV1['disk'];
}>): readonly MachineVitalsAlertTransitionV1[] {
  const transitions: MachineVitalsAlertTransitionV1[] = [];
  const latestEpisodes = new Map<string, MachineVitalsAlertEpisodeV1>();
  const key = (rule: MachineVitalsAlertEpisodeV1['rule'], volumeId?: string) => JSON.stringify([rule, volumeId ?? null]);
  for (const episode of input.episodes) latestEpisodes.set(key(episode.rule, episode.volumeId), episode);
  const transition = (rule: MachineVitalsAlertEpisodeV1['rule'], holds: boolean | null,
    evidence: MachineVitalsAlertTransitionV1['evidence'], duration: number,
    predicate?: (record: MachineVitalsMinuteRecordV1) => boolean | null, volumeId?: string) => {
    const previous = latestEpisodes.get(key(rule, volumeId));
    const open = previous?.state === 'fired';
    if (holds === null || holds === open) return;
    const streak = predicate ? isSustainedV1({ records: input.records,
      holds: record => predicate(record) === !open, sustainMs: duration, now: input.now })
      : { sustained: true, since: input.now - 60_000 };
    if (!streak.sustained || streak.since === null) return;
    transitions.push({ episode: { kind: 'alert', rule, ...(volumeId ? { volumeId } : {}),
      state: open ? 'recovered' : 'fired', at: input.now }, since: streak.since, evidence });
  };
  let latest: MachineVitalsMinuteRecordV1 | undefined;
  for (let index = input.records.length - 1; index >= 0; index--) {
    if (input.records[index].t <= input.now) { latest = input.records[index]; break; }
  }
  if (input.policy.memory.enabled) {
    const rule = input.policy.memory;
    const condition = (record: MachineVitalsMinuteRecordV1) => record.lvl === 'not_reported' ? null
      : record.lvl === 'critical' || rule.level === 'elevated' && record.lvl === 'elevated';
    transition('memory', latest ? condition(latest) : null, { level: rule.level, sustainMs: rule.sustainMs,
      ...(latest?.swp === null || latest?.swp === undefined ? {} : { swapUsedBytes: latest.swp }) }, rule.sustainMs, condition);
  }
  if (input.policy.cpu.enabled) {
    const rule = input.policy.cpu;
    const condition = (record: MachineVitalsMinuteRecordV1) => record.cpu === null ? null : record.cpu > rule.abovePct;
    if (latest?.cpu !== null && latest?.cpu !== undefined) transition('cpu', condition(latest),
      { abovePct: rule.abovePct, sustainMs: rule.sustainMs, busyPct: latest.cpu }, rule.sustainMs, condition);
  }
  if (input.policy.disk.enabled && input.disk?.reported) {
    const threshold = input.policy.disk.threshold;
    for (const volume of input.disk.volumes) {
      const holds = resolveMachineDiskAttentionKindV1(volume, threshold) !== null;
      transition('disk', holds, { freeBytes: volume.availableBytes, totalBytes: volume.totalBytes, threshold }, 60_000,
        undefined, volume.id);
    }
  }
  return transitions;
}
