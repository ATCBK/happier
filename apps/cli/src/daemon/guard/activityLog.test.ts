import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { createActivityLog } from './activityLog';
import { createMachineResourceSummary } from '../resources/machineResourceSummary';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';

const roots: string[] = [];
const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await Promise.all(releases.splice(0).map(release => release()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const initialTime = Date.UTC(2026, 9, 10, 12);
const attribution = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'install' };
function entry(id: string, patch: Partial<MachineGuardActivityEntryV1> = {}): MachineGuardActivityEntryV1 {
  return { v: 1, id, at: initialTime, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done',
    attribution, subject: { kind: 'session', sessionId: id, title: `Private ${id}` }, ...patch };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-guard-activity-')); roots.push(root);
  let now = initialTime;
  const historyStore = await createMinuteHistoryStore({ directory: join(root, 'history') });
  // OS reader boundary only; sampler/history/summary and Activity remain real.
  const sampler = createMachineVitalsSampler({ historyStore, readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) } });
  await sampler.start();
  const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, nowMs: () => now, onError: error => { throw error; } });
  releases.push(() => { summary.stop(); return sampler.stop(); });
  const create = () => createActivityLog({ activeServerDir: root, nowMs: () => now, resourceSummary: summary });
  const log = await create();
  return { root, directory: join(root, 'machine-guard'), log, summary, create, now: (value: number) => { now = value; } };
}

describe('daemon Activity log through protected day-partitioned storage', () => {
  it('honors the current admitted machine and installation when projecting recipient receipts', async () => {
    const f = await fixture();
    await f.log.append(entry('current'));
    await f.log.append(entry('previous-installation', { attribution: { ...attribution, installationId: 'previous' } }));
    await f.log.append(entry('different-machine', { attribution: { ...attribution, machineId: 'different' } }));
    const view = await f.log.list({ range: 'today', requester: attribution });
    expect(view.entries.map(row => row.id)).toEqual(['current']);
    expect(view.counts).toEqual({ stopped: 1, cleanedUp: 0, needsLook: 0, others: 2 });
    expect((await f.log.list({ range: 'today', requester: { serverId: 'home', accountId: 'owner' } })).entries).toHaveLength(3);
  });

  it('invalidates watch observers only after durable append, isolates failed observers, and releases subscriptions', async () => {
    const f = await fixture();
    const observed: Array<Promise<string>> = [];
    const path = join(f.directory, 'activity-2026-10-10.jsonl');
    f.log.subscribe(() => { throw new Error('Failed external watch observer'); });
    const release = f.log.subscribe(() => { observed.push(readFile(path, 'utf8')); });
    await f.log.append(entry('maintenance', { kind: 'housekeeping', rule: 'housekeeping' }));
    expect(observed).toHaveLength(1);
    expect(await observed[0]).toContain('"id":"maintenance"');
    await f.log.markUndone({ id: 'undo', ref: 'maintenance', at: initialTime, attribution });
    expect(await observed[1]).toContain('"id":"undo"');
    await mkdir(join(f.directory, 'activity-2026-10-11.jsonl'));
    await expect(f.log.append(entry('uncommitted', { at: initialTime + 86_400_000 }))).rejects.toThrow();
    expect(observed).toHaveLength(2);
    release();
    await f.log.append(entry('later'));
    expect(observed).toHaveLength(2);
  });

  it('publishes only successful guard stops through the real summary after the durable receipt exists', async () => {
    const f = await fixture();
    for (const row of [entry('maintenance', { kind: 'housekeeping', rule: 'housekeeping' }),
      entry('trash', { kind: 'trash_moved', rule: 'approved_proposal' }), entry('terminal', { kind: 'closed_terminal', rule: 'idle_terminals' }),
      entry('failed', { outcome: 'failed' }), entry('system', { rule: 'system' }), entry('kept', { kind: 'kept_running' })]) {
      await f.log.append(row);
      expect(f.summary.getSummary()?.lastAutomaticAction).toBeUndefined();
    }
    await f.log.append(entry('guard', { freedBytes: 256, wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'guard' } }] }));
    expect(f.summary.getSummary()?.lastAutomaticAction).toEqual({ at: initialTime, kind: 'stopped_session', entryId: 'guard',
      undoable: true, facts: { rule: 'idle_sessions', freedBytes: 256 } });
    expect(await readFile(join(f.directory, 'activity-2026-10-10.jsonl'), 'utf8')).toContain('"id":"guard"');
    await f.log.markUndone({ id: 'undo', at: initialTime + 1, ref: 'guard', attribution });
    expect(f.summary.getSummary()?.lastAutomaticAction?.entryId).toBe('guard');
    await expect(f.log.append({ ...entry('invalid'), at: Number.NaN })).rejects.toThrow();
    expect(f.summary.getSummary()?.lastAutomaticAction?.entryId).toBe('guard');
    await mkdir(join(f.directory, 'activity-2026-10-11.jsonl'));
    await expect(f.log.append(entry('failed-durable-append', { at: initialTime + 86_400_000 }))).rejects.toThrow();
    expect(f.summary.getSummary()?.lastAutomaticAction?.entryId).toBe('guard');
  });

  it('reports a guard stop without promising undo for non-restorative way-back Actions', async () => {
    const f = await fixture();
    await f.log.append(entry('review-only', { kind: 'stopped_left_behind', rule: 'left_behind',
      subject: { kind: 'processes', count: 2 },
      wayBack: [{ label: 'review_processes', actionId: 'machines.guard.get', input: { machineId: 'machine' } }],
    }));
    expect(f.summary.getSummary()?.lastAutomaticAction).toEqual({ at: initialTime,
      kind: 'stopped_left_behind', entryId: 'review-only', undoable: false,
      facts: { rule: 'left_behind', count: 2 },
    });
    expect((await f.log.read('review-only'))?.wayBack?.[0].label).toBe('review_processes');
  });

  it('folds append-only undo across restart, tolerates torn rows, and filters private recipients before counts', async () => {
    const f = await fixture();
    await f.log.append(entry('own'));
    await f.log.append(entry('other', { attribution: { ...attribution, accountId: 'other' } }));
    await f.log.append(entry('unknown', { attribution: { kind: 'unknown' } }));
    await f.log.append(entry('same-account-other-home', { attribution: { ...attribution, serverId: 'other-home' } }));
    const path = join(f.directory, 'activity-2026-10-10.jsonl');
    await appendFile(path, `bad-json\n{"v":1}\n${JSON.stringify({ ...entry('unknown-kind'), kind: 'future_activity' })}\n{"v":`);
    await f.log.markUndone({ id: 'undo', at: initialTime + 5, ref: 'own', attribution });
    await appendFile(path, `${JSON.stringify({ ...entry('future'), future: true, subject: { kind: 'browser', future: true } })}\n`);
    await appendFile(path, JSON.stringify(entry('uncommitted')));
    f.now(initialTime + 10);
    const restarted = await f.create();
    expect(await restarted.read('own')).toMatchObject({ id: 'own', undoneAt: initialTime + 5 });
    const recipient = await restarted.list({ range: 'today', requester: { serverId: 'home', accountId: 'owner' } });
    expect(recipient.entries.map(row => row.id)).toEqual(['future', 'own']);
    expect(recipient.counts).toEqual({ stopped: 2, cleanedUp: 0, needsLook: 0, others: 3 });
    expect(JSON.stringify(recipient)).not.toContain('Private other');
    expect((await restarted.list({ range: 'today' })).entries).toHaveLength(5);
    expect(await readFile(path, 'utf8')).toContain('"kind":"undone"');
  });

  it('prunes whole 30-day partitions at startup and rollover, preserving the boundary day and range/filter views', async () => {
    const f = await fixture();
    await f.log.append(entry('expired', { at: initialTime - 32 * 86_400_000 }));
    await f.log.append(entry('boundary', { at: initialTime - 30 * 86_400_000 }));
    await f.create();
    expect(await readdir(f.directory)).not.toContain('activity-2026-09-08.jsonl');
    expect(await readdir(f.directory)).toContain('activity-2026-09-10.jsonl');
    await f.log.append(entry('cleanup', { kind: 'trash_emptied', rule: 'approved_proposal', at: initialTime - 86_400_000 }));
    await f.log.append(entry('attention', { kind: 'out_of_steps', rule: 'memory_guard' }));
    expect((await f.log.list({ range: '7d', filter: 'cleaned_up' })).entries.map(row => row.id)).toEqual(['cleanup']);
    expect((await f.log.list({ range: 'today', filter: 'needs_look' })).entries.map(row => row.id)).toEqual(['attention']);
    f.now(initialTime + 86_400_000);
    await f.log.append(entry('tomorrow', { at: initialTime + 86_400_000 }));
    expect(await readdir(f.directory)).not.toContain('activity-2026-09-10.jsonl');
    expect((await f.log.list({ range: 'today' })).entries.map(row => row.id)).toEqual(['tomorrow']);
  });
});
