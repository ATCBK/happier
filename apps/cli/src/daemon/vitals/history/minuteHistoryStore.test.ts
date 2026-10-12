import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { createMinuteHistoryStore } from './minuteHistoryStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const minute = (t: number): MachineVitalsMinuteRecordV1 => ({ t, cpu: 20, cpuMax: 50, mem: 10, memMax: 20,
  lvl: 'calm', swp: null, rx: 30, tx: 40 });

describe('minute history store', () => {
  it('restores a tolerant strictly increasing stream with gaps and alert episodes from the same files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-minute-history-'));
    roots.push(directory);
    const now = Date.UTC(2026, 9, 10, 12);
    const store = await createMinuteHistoryStore({ directory, nowMs: () => now });
    const first = minute(now - 240_000);
    expect(await store.append(first)).toBe(true);
    const alert = { kind: 'alert' as const, rule: 'memory' as const, state: 'fired' as const, at: now - 120_000 };
    await store.appendAlert(alert);
    expect(await store.append(minute(now - 120_000))).toBe(true);
    expect(await store.append(minute(now - 180_000))).toBe(false);
    await appendFile(join(directory, 'minutes-2026-10-10.jsonl'),
      `${JSON.stringify({ ...minute(now - 60_000), future: 'ignored' })}\n{"bad":true}\n{"t":`);
    const restored = await createMinuteHistoryStore({ directory, nowMs: () => now });
    expect(restored.minutes(0)).toEqual([first, minute(now - 120_000), minute(now - 60_000)]);
    expect(restored.alerts()).toEqual([alert]);
    expect(await restored.append(minute(now - 180_000))).toBe(false);
    expect(await restored.append(minute(now))).toBe(true);
    expect(await restored.read(now - 60_000)).toEqual([minute(now - 60_000), minute(now)]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-10.jsonl']);
  });

  it('prunes at startup and day rollover, including cached rows beyond the rolling seven-day window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-minute-retention-'));
    roots.push(directory);
    let now = Date.UTC(2026, 9, 2, 12);
    const store = await createMinuteHistoryStore({ directory, nowMs: () => now });
    await store.append(minute(now));
    now = Date.UTC(2026, 9, 3, 12);
    await store.append(minute(now));
    now = Date.UTC(2026, 9, 10, 12);
    const restored = await createMinuteHistoryStore({ directory, nowMs: () => now });
    expect(restored.minutes(0)).toEqual([minute(Date.UTC(2026, 9, 3, 12))]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-03.jsonl']);
    now = Date.UTC(2026, 9, 11);
    await restored.append(minute(now));
    expect(restored.minutes(0)).toEqual([minute(now)]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-11.jsonl']);
  });
});
