import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDayPartitionedJsonl } from './dayPartitionedJsonl';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-day-journal-'));
  directories.push(root);
  const directory = join(root, 'journal');
  await mkdir(directory, { mode: 0o700 });
  const store = await createDayPartitionedJsonl({ directory, prefix: 'events', nowMs: () => Date.UTC(2026, 9, 10, 12),
    timestamp: (row: { at: number; value: string }) => row.at,
    parse: (value) => {
      if (typeof value !== 'object' || value === null || !('at' in value) || !('value' in value)
        || typeof value.at !== 'number' || typeof value.value !== 'string') return null;
      return { at: value.at, value: value.value };
    } });
  return { root, directory, store };
}

describe('day-partitioned JSONL', () => {
  it('appends to protected UTC partitions and skips corrupt or incomplete rows without losing later appends', async () => {
    const { directory, store } = await fixture();
    const first = { at: Date.UTC(2026, 9, 10), value: 'first' };
    await store.append(first);
    expect(await store.read(first.at)).toEqual([first]);
    const path = join(directory, 'events-2026-10-10.jsonl');
    await appendFile(path, 'not-json\n{"at":5}\n{"at":');
    await store.append({ at: first.at + 60_000, value: 'after tear' });
    await appendFile(path, `${JSON.stringify({ at: first.at + 120_000, value: 'future', unknown: true })}\n`);
    await appendFile(path, JSON.stringify({ at: first.at + 180_000, value: 'no newline' }));
    expect(await store.read(first.at)).toEqual([first, { at: first.at + 60_000, value: 'after tear' },
      { at: first.at + 120_000, value: 'future' }]);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path, 'utf8')).toContain('after tear');
  });

  it('prunes whole owned partitions and preserves the partially retained UTC day and unrelated files', async () => {
    const { directory, store } = await fixture();
    await store.append({ at: Date.UTC(2026, 9, 2), value: 'old' });
    await store.append({ at: Date.UTC(2026, 9, 3), value: 'retained day' });
    await writeFile(join(directory, 'other-2026-10-01.jsonl'), 'unrelated');
    await store.pruneOlderThan(7);
    expect(await store.read(0)).toEqual([{ at: Date.UTC(2026, 9, 3), value: 'retained day' }]);
    expect(await readFile(join(directory, 'other-2026-10-01.jsonl'), 'utf8')).toBe('unrelated');
    await expect(stat(join(directory, 'events-2026-10-02.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('refuses a partition symlink before disclosure or append', async () => {
    const { root, directory, store } = await fixture();
    const external = join(root, 'external');
    await writeFile(external, '{"at":1,"value":"secret"}\n', { mode: 0o600 });
    await symlink(external, join(directory, 'events-2026-10-10.jsonl'));
    await expect(store.read(0)).rejects.toThrow(/symbolic link/);
    await expect(store.append({ at: Date.UTC(2026, 9, 10), value: 'write' })).rejects.toThrow(/symbolic link/);
    expect(await readFile(external, 'utf8')).toBe('{"at":1,"value":"secret"}\n');
  });
});
