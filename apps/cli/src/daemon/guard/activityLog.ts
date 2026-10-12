import { join } from 'node:path';
import type { MachineGuardActivityEntryV1, MachineGuardActivityListV1, MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { MachineGuardActivityEntryV1Schema, MachineGuardActivityStoredReadV1Schema, isGuardActionEntry, isMachineGuardRestorationWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { MachineResourceSummary } from '../resources/machineResourceSummary';
import { createDayPartitionedJsonl } from '../persistence/dayPartitionedJsonl';
import { logger } from '@/ui/logger';

export type ActivityLogListInput = Readonly<{
  range: 'today' | '7d' | '30d'; filter?: 'all' | 'stopped' | 'cleaned_up' | 'needs_look';
  requester?: Readonly<{ serverId: string; accountId: string; machineId?: string; installationId?: string }>;
}>;
export type GuardActivityRequesterScope = NonNullable<ActivityLogListInput['requester']>;

export function projectGuardActivityRowsForRequester(
  rows: readonly MachineGuardActivityRowV1[],
  requester?: GuardActivityRequesterScope,
): { entries: MachineGuardActivityRowV1[]; others: number } {
  const entries = requester ? rows.filter(row => 'accountId' in row.attribution
    && row.attribution.serverId === requester.serverId && row.attribution.accountId === requester.accountId
    && (requester.machineId === undefined || row.attribution.machineId === requester.machineId)
    && (requester.installationId === undefined || row.attribution.installationId === requester.installationId)) : [...rows];
  return { entries, others: rows.length - entries.length };
}

export type ActivityLog = Readonly<{
  append(entry: MachineGuardActivityEntryV1): Promise<void>;
  read(entryId: string): Promise<MachineGuardActivityRowV1 | null>;
  list(input: ActivityLogListInput): Promise<MachineGuardActivityListV1>;
  markUndone(input: Pick<MachineGuardActivityEntryV1, 'id' | 'at' | 'attribution'> & { ref: string }): Promise<void>;
  subscribe(listener: () => void): () => void;
}>;

export async function createActivityLog(input: Readonly<{
  activeServerDir: string; nowMs?: () => number;
  resourceSummary: Pick<MachineResourceSummary, 'reportAutomaticAction'>;
}>): Promise<ActivityLog> {
  const nowMs = input.nowMs ?? Date.now;
  const listeners = new Set<() => void>();
  const journal = await createDayPartitionedJsonl({ directory: join(input.activeServerDir, 'machine-guard'), prefix: 'activity', nowMs,
    timestamp: (row: MachineGuardActivityEntryV1) => row.at,
    parse: value => { const result = MachineGuardActivityStoredReadV1Schema.safeParse(value); return result.success ? result.data : null; } });
  const dayMs = 86_400_000;
  let prunedDay: string | undefined;
  const pruneAtDayBoundary = async () => {
    const day = new Date(nowMs()).toISOString().slice(0, 10);
    if (day === prunedDay) return;
    await journal.pruneOlderThan(30);
    prunedDay = day;
  };
  await pruneAtDayBoundary();
  const append = async (entry: MachineGuardActivityEntryV1) => {
    const parsed = MachineGuardActivityEntryV1Schema.parse(entry);
    await pruneAtDayBoundary();
    await journal.append(parsed);
    // The durable append is the receipt. Never announce an effect that failed to commit.
    if (isGuardActionEntry(parsed)) input.resourceSummary.reportAutomaticAction({
      at: parsed.at, kind: parsed.kind, entryId: parsed.id, undoable: parsed.wayBack?.some(isMachineGuardRestorationWayBackV1) ?? false,
      facts: { rule: parsed.rule,
        ...(parsed.freedBytes === undefined ? {} : { freedBytes: parsed.freedBytes }),
        ...(parsed.inTrashBytes === undefined ? {} : { inTrashBytes: parsed.inTrashBytes }),
        ...(parsed.subject?.kind === 'processes' ? { count: parsed.subject.count } : {}),
      },
    });
    for (const listener of [...listeners]) {
      try { listener(); }
      catch { logger.debug('[ActivityLog] Change subscriber failed after durable append'); }
    }
  };
  const readRows = async (sinceMs: number, asOf: number): Promise<MachineGuardActivityRowV1[]> => {
    await pruneAtDayBoundary();
    const records = (await journal.read(sinceMs)).filter(row => row.at <= asOf);
    const undone = new Map<string, number>();
    for (const row of records) if (row.kind === 'undone' && row.ref) {
      undone.set(row.ref, Math.min(undone.get(row.ref) ?? row.at, row.at));
    }
    return records.filter(row => row.kind !== 'undone').map(row => {
      const undoneAt = undone.get(row.id);
      return undoneAt === undefined ? row : { ...row, undoneAt };
    }).reverse().sort((a, b) => b.at - a.at);
  };
  const stopped = (row: MachineGuardActivityRowV1) => ['stopped_session', 'closed_browser', 'stopped_service', 'stopped_left_behind', 'closed_terminal'].includes(row.kind);
  const cleanedUp = (row: MachineGuardActivityRowV1) => ['trash_moved', 'trash_emptied', 'housekeeping'].includes(row.kind);
  const needsLook = (row: MachineGuardActivityRowV1) => row.outcome !== 'done'
    || ['out_of_steps', 'stop_failed', 'ceiling_near', 'ceiling_reached', 'system_oom_kill', 'start_failed'].includes(row.kind);
  return {
    append,
    read: async id => { const at = nowMs(); return (await readRows(at - 30 * dayMs, at)).find(row => row.id === id) ?? null; },
    list: async (request) => {
      const asOf = nowMs();
      const since = request.range === 'today' ? Math.floor(asOf / dayMs) * dayMs : asOf - (request.range === '7d' ? 7 : 30) * dayMs;
      const rows = await readRows(since, asOf);
      const { entries: visible, others } = projectGuardActivityRowsForRequester(rows, request.requester);
      const counts = { stopped: visible.filter(stopped).length, cleanedUp: visible.filter(cleanedUp).length,
        needsLook: visible.filter(needsLook).length, others };
      const filter = request.filter ?? 'all';
      return { entries: filter === 'all' ? visible : visible.filter(filter === 'stopped' ? stopped : filter === 'cleaned_up' ? cleanedUp : needsLook), counts, asOf };
    },
    markUndone: entry => append({ ...entry, v: 1, kind: 'undone', rule: 'system', outcome: 'done' }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
