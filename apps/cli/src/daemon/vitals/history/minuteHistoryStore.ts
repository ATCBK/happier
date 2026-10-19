import { z } from 'zod/mini';
import { MachineVitalsAlertEpisodeV1Schema, MachineVitalsAlertEpisodeV1StoredReadSchema,
  MachineVitalsMinuteRecordV1Schema, MachineVitalsMinuteRecordV1StoredReadSchema,
  type MachineVitalsAlertEpisodeV1, type MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { createDayPartitionedJsonl } from '../../persistence/dayPartitionedJsonl';

export type MinuteHistoryStore = Readonly<{
  append: (record: MachineVitalsMinuteRecordV1) => Promise<boolean>;
  appendAlert: (episode: MachineVitalsAlertEpisodeV1) => Promise<void>;
  minutes: (sinceMs: number) => readonly MachineVitalsMinuteRecordV1[];
  alerts: () => readonly MachineVitalsAlertEpisodeV1[];
  read: (sinceMs: number) => Promise<readonly MachineVitalsMinuteRecordV1[]>;
  prune: () => Promise<void>;
}>;

export async function createMinuteHistoryStore(input: Readonly<{
  directory: string;
  nowMs?: () => number;
}>): Promise<MinuteHistoryStore> {
  const nowMs = input.nowMs ?? Date.now;
  const retentionMs = 7 * 86_400_000;
  // Active episodes are custody, not display history. Carry them forward in the
  // same stream before deleting their day, without changing their original fire time.
  const checkpointSchema = z.object({ kind: z.literal('alert_checkpoint'), at: z.number().check(z.int(), z.nonnegative()),
    episode: MachineVitalsAlertEpisodeV1StoredReadSchema });
  type Row = MachineVitalsMinuteRecordV1 | MachineVitalsAlertEpisodeV1 | z.infer<typeof checkpointSchema>;
  const timestamp = (record: Row) => 'kind' in record ? record.at : record.t;
  const episodeKey = (episode: MachineVitalsAlertEpisodeV1) => JSON.stringify([episode.rule, episode.volumeId ?? null]);
  const journal = await createDayPartitionedJsonl<Row>({ directory: input.directory, prefix: 'minutes', nowMs,
    timestamp,
    parse: (value) => {
      const minute = MachineVitalsMinuteRecordV1StoredReadSchema.safeParse(value);
      if (minute.success) return minute.data;
      const alert = MachineVitalsAlertEpisodeV1StoredReadSchema.safeParse(value);
      if (alert.success) return alert.data;
      const checkpoint = checkpointSchema.safeParse(value);
      return checkpoint.success ? checkpoint.data : null;
    } });
  let records: MachineVitalsMinuteRecordV1[] = [];
  let episodes: MachineVitalsAlertEpisodeV1[] = [];
  const episodeJournalTimes = new Map<string, number>();
  let lastMinute = -Infinity;
  // Read before pruning: a daemon may have been down longer than the history window.
  for (const row of await journal.read(-Infinity)) {
    if ('kind' in row) {
      const episode = row.kind === 'alert_checkpoint' ? row.episode : row;
      episodeJournalTimes.set(episodeKey(episode), row.at);
      if (row.kind !== 'alert_checkpoint' || !episodes.some(existing => existing.at === episode.at
        && episodeKey(existing) === episodeKey(episode) && existing.state === episode.state)) episodes.push(episode);
    }
    else if (row.t > lastMinute) {
      records.push(row);
      lastMinute = row.t;
    }
  }
  let lastDay = Math.floor(nowMs() / 86_400_000);
  let pending = Promise.resolve();
  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }
  function trimCache() {
    const cutoff = nowMs() - retentionMs;
    records = records.filter((record) => record.t >= cutoff);
    const latest = new Map(episodes.map(episode => [episodeKey(episode), episode]));
    episodes = episodes.filter((episode) => episode.at >= cutoff
      || latest.get(episodeKey(episode)) === episode && episode.state === 'fired');
    const retainedKeys = new Set(episodes.map(episodeKey));
    for (const key of episodeJournalTimes.keys()) if (!retainedKeys.has(key)) episodeJournalTimes.delete(key);
  }
  async function prune() {
    const oldestDay = Math.floor((nowMs() - retentionMs) / 86_400_000) * 86_400_000;
    for (const [key, episode] of new Map(episodes.map(episode => [episodeKey(episode), episode]))) {
      if (episode.state === 'fired' && (episodeJournalTimes.get(key) ?? episode.at) < oldestDay) {
        const at = nowMs();
        await journal.append({ kind: 'alert_checkpoint', at, episode });
        episodeJournalTimes.set(key, at);
      }
    }
    await journal.pruneOlderThan(7);
    trimCache();
    lastDay = Math.floor(nowMs() / 86_400_000);
  }
  async function pruneAtRollover() {
    if (Math.floor(nowMs() / 86_400_000) > lastDay) await prune();
    else trimCache();
  }
  function minutes(sinceMs: number): readonly MachineVitalsMinuteRecordV1[] {
    trimCache();
    return records.filter((record) => record.t >= sinceMs);
  }
  await prune();
  return {
    append: (record) => serialize(async () => {
      const canonical = MachineVitalsMinuteRecordV1Schema.parse(record);
      if (canonical.t <= lastMinute) return false;
      await pruneAtRollover();
      await journal.append(canonical);
      lastMinute = canonical.t;
      records.push(canonical);
      return true;
    }),
    appendAlert: (episode) => serialize(async () => {
      const canonical = MachineVitalsAlertEpisodeV1Schema.parse(episode);
      await pruneAtRollover();
      await journal.append(canonical);
      episodes.push(canonical);
      episodeJournalTimes.set(episodeKey(canonical), canonical.at);
    }),
    minutes,
    alerts: () => { trimCache(); return episodes.slice(); },
    read: (sinceMs) => serialize(async () => minutes(sinceMs)),
    prune: () => serialize(prune),
  };
}
