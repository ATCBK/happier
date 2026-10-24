import type {
  PileApplyResultV1,
  PileSummaryV1,
  StorageItemRefV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';
import { toStorageItemRef } from '@/sync/domains/machines/storage/pileRef';
import { storageVerdictStartsTicked } from '@/sync/domains/machines/storage/storageVerdictSelection';
import { resolveHappierListMultiSelectionRange } from '@happier-dev/plugin-ui/presentation';

/**
 * Collecting (plan 40 STO-11, ruling 4, lab `rs` PM): ticking a row is putting it in the machine's one
 * pile. The pile on the machine is the only authority; a row's tick is only how the pile reads for that
 * row, and every tick is one `machines.storage.pile.set` delta. Nothing here stores a selection.
 */

/**
 * How a row's box reads: in the pile; covered because a folder holding it is in the pile; free to tick;
 * a Keep item whose box first asks the person to confirm what is lost (R42.1); or no box at all
 * (Forbidden, not checked yet, or not collectable).
 */
export type StorageCollectState =
  | 'collected'
  | 'inside'
  | 'available'
  | 'confirm'
  | 'none';
export type StorageCollectable = Pick<
  StorageItemV1,
  'itemId' | 'path' | 'verdict' | 'collectable'
>;
/** One `pile.set` delta (its arrays are the Action input's): served references in, item ids out. */
export type StoragePileDelta = Readonly<{ add?: StorageItemRefV1[]; remove?: string[] }>;
/**
 * The pile's membership as a row reads it: the machine's own refs plus any delta still on its way,
 * which carry only the served reference until the machine answers.
 */
export type StoragePileMembership = readonly Readonly<StorageItemRefV1>[];

/** What the pile bar says after the review sheet acted, held for the machine until dismissed. */
export type StoragePileReceipt =
  | Readonly<{
      kind: 'applied';
      result: PileApplyResultV1;
      emptiesAt: number | null;
    }>
  | Readonly<{ kind: 'emptied'; count: number; freedBytes: number }>;

export type StoragePileBar =
  | Readonly<{ kind: 'hidden' }>
  | Readonly<{ kind: 'ready'; count: number; freesBytes: number }>
  | Readonly<{ kind: 'checking'; count: number; freesBytes: number }>
  /** Moved to Happier's Trash: the space is not back yet (R25). */
  | Readonly<{
      kind: 'held';
      batchId: string;
      count: number;
      /** Null when the remaining entries do not prove a physical allocation union. */
      inTrashBytes: number | null;
      notActed: number;
      emptiesAt: number | null;
    }>
  /** True at once: deleted now, or the Trash was emptied. */
  | Readonly<{ kind: 'freed'; count: number; freedBytes: number }>;

function trimEnd(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
}

/** `child` sits inside `parent` (either separator; a sibling sharing a prefix is not inside). */
export function storagePathContains(parent: string, child: string): boolean {
  const a = trimEnd(parent);
  const b = trimEnd(child);
  if (b.length <= a.length || !b.startsWith(a)) return false;
  const next = b.charAt(a.length);
  return next === '/' || next === '\\' || a.endsWith('/') || a.endsWith('\\');
}

function pileEntryFor(
  item: StorageCollectable,
  pile: StoragePileMembership,
): Readonly<StorageItemRefV1> | null {
  return (
    pile.find(
      (entry) =>
        entry.itemId === item.itemId ||
        trimEnd(entry.path) === trimEnd(item.path),
    ) ?? null
  );
}

export function describeStorageCollect(
  item: StorageCollectable,
  pile: StoragePileMembership,
): StorageCollectState {
  if (item.verdict === 'forbidden') return 'none';
  if (pileEntryFor(item, pile)) return 'collected';
  if (pile.some((entry) => storagePathContains(entry.path, item.path)))
    return 'inside';
  if (
    !item.collectable ||
    item.verdict === 'check'
  )
    return 'none';
  return item.verdict === 'keep' ? 'confirm' : 'available';
}


export function resolveStorageCollectToggle(
  item: StorageCollectable,
  pile: StoragePileMembership,
): StoragePileDelta | null {
  const state = describeStorageCollect(item, pile);
  if (state === 'collected') return { remove: [pileEntryFor(item, pile)!.itemId] };
  return state === 'available' || state === 'confirm'
    ? { add: [toStorageItemRef(item)] }
    : null;
}

/** Group and range sweeps take the verdict default; Caution and Keep require an explicit row choice. */
function sweepable(
  item: StorageCollectable,
  pile: StoragePileMembership,
): boolean {
  if (!storageVerdictStartsTicked(item.verdict)) return false;
  const state = describeStorageCollect(item, pile);
  return state === 'collected' || state === 'available';
}

export function describeStorageGroupCollect(
  items: readonly StorageCollectable[],
  pile: StoragePileMembership,
): 'checked' | 'mixed' | 'unchecked' | null {
  const candidates = items.filter((item) => sweepable(item, pile));
  if (candidates.length === 0) return null;
  const collected = candidates.filter((item) =>
    pileEntryFor(item, pile),
  ).length;
  return collected === 0
    ? 'unchecked'
    : collected === candidates.length
      ? 'checked'
      : 'mixed';
}

/** "Collect all N that can go": adds the rest; when all of them are in, the same press takes them out. */
export function resolveStorageCollectAll(
  items: readonly StorageCollectable[],
  pile: StoragePileMembership,
): StoragePileDelta | null {
  const state = describeStorageGroupCollect(items, pile);
  if (state === null) return null;
  const candidates = items.filter((item) => sweepable(item, pile));
  if (state === 'checked')
    return {
      remove: candidates.map((item) => pileEntryFor(item, pile)!.itemId),
    };
  const add = candidates
    .filter((item) => !pileEntryFor(item, pile))
    .map(toStorageItemRef);
  return add.length ? { add } : null;
}

export function describeStoragePileBar(
  input: Readonly<{
    pile: PileSummaryV1 | null;
    receipt: StoragePileReceipt | null;
    checking: Readonly<{ count: number; freesBytes: number }> | null;
  }>,
): StoragePileBar {
  if (input.checking) return { kind: 'checking', ...input.checking };
  const { receipt } = input;
  if (receipt?.kind === 'emptied')
    return {
      kind: 'freed',
      count: receipt.count,
      freedBytes: receipt.freedBytes,
    };
  if (receipt?.kind === 'applied') {
    const { result } = receipt;
    const acted = result.outcomes.filter(
      (outcome) => outcome.status === 'moved' || outcome.status === 'deleted',
    ).length;
    if (result.mode === 'delete')
      return { kind: 'freed', count: acted, freedBytes: result.freedBytes };
    return {
      kind: 'held',
      batchId: result.batchId,
      count: acted,
      inTrashBytes: result.inTrashBytes,
      notActed: result.outcomes.length - acted,
      emptiesAt: receipt.emptiesAt,
    };
  }
  if (!input.pile || input.pile.count === 0) return { kind: 'hidden' };
  return {
    kind: 'ready',
    count: input.pile.count,
    freesBytes: input.pile.freesBytes,
  };
}

/**
 * Shift-collect (lab PM, plan 40 §7(g)): the rows between the last tick and this one, through the
 * Collection's own range resolver, counting only rows selected by the shared Safe default.
 * A collected target takes the range out; otherwise the range goes in. One `pile.set` delta.
 */
export function resolveStorageCollectRange(input: Readonly<{ rows: readonly StorageCollectable[]; pile: StoragePileMembership;
  anchorKey: string | null; targetKey: string }>): StoragePileDelta | null {
  const eligible = new Set(input.rows.filter((row) => sweepable(row, input.pile)).map((row) => row.itemId));
  const keys = new Set(resolveHappierListMultiSelectionRange({ visibleOrderedKeys: input.rows.map((row) => row.itemId),
    anchorKey: input.anchorKey, targetKey: input.targetKey, eligibleKeys: eligible }));
  if (keys.size === 0) return null;
  const inRange = input.rows.filter((row) => keys.has(row.itemId));
  const target = inRange.find((row) => row.itemId === input.targetKey)!;
  if (pileEntryFor(target, input.pile)) {
    return { remove: inRange.map((row) => pileEntryFor(row, input.pile)?.itemId).filter((id): id is string => !!id) };
  }
  const add = inRange.filter((row) => describeStorageCollect(row, input.pile) === 'available').map(toStorageItemRef);
  return add.length ? { add } : null;
}
