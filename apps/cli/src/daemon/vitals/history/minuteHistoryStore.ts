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
  type Row = MachineVitalsMinuteRecordV1 | MachineVitalsAlertEpisodeV1;
  const timestamp = (record: Row) => 'kind' in record ? record.at : record.t;
  const journal = await createDayPartitionedJsonl<Row>({ directory: input.directory, prefix: 'minutes', nowMs,
    timestamp,
    parse: (value) => {
      const minute = MachineVitalsMinuteRecordV1StoredReadSchema.safeParse(value);
      if (minute.success) return minute.data;
      const alert = MachineVitalsAlertEpisodeV1StoredReadSchema.safeParse(value);
      return alert.success ? alert.data : null;
    } });
  await journal.pruneOlderThan(7);
  let records: MachineVitalsMinuteRecordV1[] = [];
  let episodes: MachineVitalsAlertEpisodeV1[] = [];
  let lastMinute = -Infinity;
  for (const row of await journal.read(nowMs() - retentionMs)) {
    if ('kind' in row) episodes.push(row);
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
    episodes = episodes.filter((episode) => episode.at >= cutoff);
  }
  async function prune() {
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
    }),
    minutes,
    alerts: () => { trimCache(); return episodes.slice(); },
    read: (sinceMs) => serialize(async () => minutes(sinceMs)),
    prune: () => serialize(prune),
  };
}
