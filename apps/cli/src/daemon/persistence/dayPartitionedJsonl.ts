import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { createProtectedLocalStateFileExclusive, ensureProtectedLocalStateDirectory,
  listProtectedLocalStateDirectory, readProtectedLocalStateFile, removeProtectedLocalStateFile,
  verifyProtectedLocalStatePath } from '@/utils/fs/protectedLocalState';

export type DayPartitionedJsonl<T> = Readonly<{
  append: (record: T) => Promise<void>;
  read: (sinceMs: number) => Promise<readonly T[]>;
  pruneOlderThan: (days: number) => Promise<void>;
}>;

export async function createDayPartitionedJsonl<T>(input: Readonly<{
  directory: string;
  prefix: string;
  timestamp: (record: T) => number;
  parse: (value: unknown) => T | null;
  nowMs?: () => number;
}>): Promise<DayPartitionedJsonl<T>> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.prefix)) throw new Error('Invalid JSONL partition prefix');
  const nowMs = input.nowMs ?? Date.now;
  await ensureProtectedLocalStateDirectory(input.directory, { authority: 'owned' });
  const partitionPattern = new RegExp(`^${input.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const partitionNames = async () => (await listProtectedLocalStateDirectory(input.directory))
    .filter((name) => partitionPattern.test(name)).sort();
  let pending = Promise.resolve();
  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }

  return {
    append: (record) => serialize(async () => {
      const path = join(input.directory, `${input.prefix}-${day(input.timestamp(record))}.jsonl`);
      try {
        await createProtectedLocalStateFileExclusive(path, '');
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      await verifyProtectedLocalStatePath(path, 'file');
      const before = await lstat(path);
      const flags = process.platform === 'win32' ? 'a+' : constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
      const handle = await open(path, flags);
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
          throw new Error('JSONL partition identity changed while opening');
        }
        // Separate an interrupted final row from the next complete append.
        const tail = Buffer.alloc(1);
        if (opened.size > 0) await handle.read(tail, 0, 1, opened.size - 1);
        const separator = opened.size > 0 && tail[0] !== 10 ? '\n' : '';
        await handle.writeFile(`${separator}${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }),
    read: (sinceMs) => serialize(async () => {
      const records: T[] = [];
      for (const name of await partitionNames()) {
        const partitionDay = name.slice(input.prefix.length + 1, -'.jsonl'.length);
        if (Number.isFinite(sinceMs) && Date.parse(`${partitionDay}T00:00:00Z`) + 86_400_000 <= sinceMs) continue;
        const contents = await readProtectedLocalStateFile(join(input.directory, name));
        // Newline is the commit marker: a final unterminated row may be torn.
        const lines = contents.split('\n');
        lines.pop();
        for (const line of lines) {
          let value: unknown;
          try { value = JSON.parse(line); } catch { continue; }
          const record = input.parse(value);
          if (record !== null && input.timestamp(record) >= sinceMs) records.push(record);
        }
      }
      return records;
    }),
    pruneOlderThan: (days) => serialize(async () => {
      const oldestDay = day(nowMs() - days * 86_400_000);
      for (const name of await partitionNames()) {
        const partitionDay = name.slice(input.prefix.length + 1, -'.jsonl'.length);
        if (partitionDay < oldestDay) await removeProtectedLocalStateFile(join(input.directory, name));
      }
    }),
  };
}
