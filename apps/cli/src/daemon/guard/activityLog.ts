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
  revision(): number;
  subscribe(listener: () => void): () => void;
}>;

function portableActivityEntry(entry: MachineGuardActivityEntryV1): MachineGuardActivityEntryV1 {
  if (!entry.wayBack) return entry;
  return { ...entry, wayBack: entry.wayBack.map(item => {
    const input = item.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('serverId' in input)) return item;
    // Home selection belongs to the invoking Action context. A daemon profile alias
    // is not portable to another client; attribution and the exact action selection stay intact.
    const { serverId: _localServerId, ...portableInput } = input;
    return { ...item, input: portableInput };
  }) };
}

export async function createActivityLog(input: Readonly<{
  activeServerDir: string; nowMs?: () => number;
  resourceSummary: Pick<MachineResourceSummary, 'reportAutomaticAction'>;
}>): Promise<ActivityLog> {
  const nowMs = input.nowMs ?? Date.now;
  const listeners = new Set<() => void>();
  // Entry timestamps may backdate and deterministic receipt IDs may repeat.
  // A durable append or a query's real time boundary changes this projection revision.
  let revision = Date.now();
  const nextChanges: Partial<Record<ActivityLogListInput['range'], number>> = {};
  const journal = await createDayPartitionedJsonl({ directory: join(input.activeServerDir, 'machine-guard'), prefix: 'activity', nowMs,
    timestamp: (row: MachineGuardActivityEntryV1) => row.at,
    parse: value => { const result = MachineGuardActivityStoredReadV1Schema.safeParse(value); return result.success ? portableActivityEntry(result.data) : null; } });
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
    const parsed = portableActivityEntry(MachineGuardActivityEntryV1Schema.parse(entry));
    await pruneAtDayBoundary();
    await journal.append(parsed);
    revision++;
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
  const readRows = async (sinceMs: number, asOf: number): Promise<{
    rows: MachineGuardActivityRowV1[]; nextRecordAt?: number; oldestAt?: number;
  }> => {
    await pruneAtDayBoundary();
    const stored = await journal.read(sinceMs);
    const records: MachineGuardActivityEntryV1[] = [];
    let nextRecordAt: number | undefined;
    let oldestAt: number | undefined;
    for (const row of stored) {
      if (row.at > asOf) nextRecordAt = Math.min(nextRecordAt ?? row.at, row.at);
      else { records.push(row); oldestAt = Math.min(oldestAt ?? row.at, row.at); }
    }
    const undone = new Map<string, number>();
    for (const row of records) if (row.kind === 'undone' && row.ref) {
      undone.set(row.ref, Math.min(undone.get(row.ref) ?? row.at, row.at));
    }
    // Trash owns one move/empty receipt per entry. Existing receipts use that
    // entry's deterministic ID; new empties also link the original receipt.
    const emptied = new Set(records.filter(row => row.kind === 'trash_emptied' && row.outcome === 'done')
      .map(row => row.ref ?? (row.id.endsWith('-trash_emptied')
        ? `${row.id.slice(0, -'-trash_emptied'.length)}-trash_moved` : null)));
    const rows = records.filter(row => row.kind !== 'undone').map(row => {
      const undoneAt = undone.get(row.id);
      // Project current action availability without rewriting the durable
      // history or pretending that permanent emptying was an Undo.
      const { wayBack, note, ...receipt } = row;
      const trashEmptied = row.kind === 'trash_moved' && emptied.has(row.id);
      const available = undoneAt !== undefined || row.kind === 'kept_running' || trashEmptied ? undefined : wayBack;
      return { ...receipt, ...(available?.length ? { wayBack: available } : {}),
        ...(note !== undefined && row.kind !== 'start_failed' ? { note } : {}),
        ...(trashEmptied ? { inTrashBytes: 0 } : {}), ...(undoneAt === undefined ? {} : { undoneAt }) };
    }).reverse().sort((a, b) => b.at - a.at);
    return { rows, nextRecordAt, oldestAt };
  };
  const stopped = (row: MachineGuardActivityRowV1) => ['stopped_session', 'closed_browser', 'stopped_service', 'stopped_left_behind', 'closed_terminal'].includes(row.kind);
  const cleanedUp = (row: MachineGuardActivityRowV1) => ['trash_moved', 'trash_emptied', 'housekeeping'].includes(row.kind);
  const needsLook = (row: MachineGuardActivityRowV1) => row.outcome !== 'done'
    || ['out_of_steps', 'stop_failed', 'ceiling_near', 'ceiling_reached', 'system_oom_kill', 'start_failed'].includes(row.kind);
  const readRevision = () => {
    const at = nowMs();
    let expired = false;
    // Only three range deadlines survive a read. No receipt or requester state is retained.
    // The existing parked-watch window checks these on re-arm; no query timer is needed.
    for (const range of ['today', '7d', '30d'] as const) {
      const deadline = nextChanges[range];
      if (deadline !== undefined && at >= deadline) { delete nextChanges[range]; expired = true; }
    }
    if (expired) revision++;
    return revision;
  };
  const list = async (request: ActivityLogListInput): Promise<MachineGuardActivityListV1> => {
    // A direct list read must not overwrite an elapsed boundary before watches observe it.
    readRevision();
    const asOf = nowMs();
    const since = request.range === 'today' ? Math.floor(asOf / dayMs) * dayMs : asOf - (request.range === '7d' ? 7 : 30) * dayMs;
    const { rows, oldestAt, nextRecordAt } = await readRows(since, asOf);
    const { entries: visible, others } = projectGuardActivityRowsForRequester(rows, request.requester);
    const counts = { stopped: visible.filter(stopped).length, cleanedUp: visible.filter(cleanedUp).length,
      needsLook: visible.filter(needsLook).length, others };
    const filter = request.filter ?? 'all';
    const expiry = request.range === 'today' ? since + dayMs : oldestAt === undefined ? undefined
      // Reads include their lower boundary; Date.now first excludes it on the next millisecond.
      : Math.floor(oldestAt + (request.range === '7d' ? 7 : 30) * dayMs) + 1;
    const nextChangeAt = Math.min(expiry ?? Infinity, nextRecordAt === undefined ? Infinity : Math.ceil(nextRecordAt));
    if (Number.isFinite(nextChangeAt)) nextChanges[request.range] = nextChangeAt;
    else delete nextChanges[request.range];
    return { entries: filter === 'all' ? visible : visible.filter(filter === 'stopped' ? stopped : filter === 'cleaned_up' ? cleanedUp : needsLook), counts, asOf };
  };
  return {
    append,
    read: async id => { const at = nowMs(); return (await readRows(at - 30 * dayMs, at)).rows.find(row => row.id === id) ?? null; },
    list,
    markUndone: entry => append({ ...entry, v: 1, kind: 'undone', rule: 'system', outcome: 'done' }),
    revision: readRevision,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
