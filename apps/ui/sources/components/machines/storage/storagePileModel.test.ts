import { describe, expect, it } from 'vitest';
import type {
  PileApplyResultV1,
  PileItemRefV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';

import {
  describeStorageCollect,
  describeStorageGroupCollect,
  describeStoragePileBar,
  resolveStorageCollectAll,
  resolveStorageCollectRange,
  resolveStorageCollectToggle,
} from './storagePileModel';

const size = (bytes: number) => ({
  allocatedBytes: bytes,
  freesBytes: bytes,
  sharedBytes: 0,
  sharedExtentsUnmeasured: false,
  atLeast: false,
});
const item = (
  itemId: string,
  path: string,
  verdict: StorageItemV1['verdict'],
  over: Partial<StorageItemV1> = {},
): StorageItemV1 => ({
  itemId,
  kind: 'worktree',
  title: itemId,
  evidence: [],
  path,
  size: size(10),
  verdict,
  reason: {
    code:
      verdict === 'keep'
        ? 'changed_files'
        : verdict === 'forbidden'
          ? 'home_folder'
          : verdict === 'check'
            ? 'facts_unavailable'
            : 'merged_clean',
  },
  collectable: verdict !== 'forbidden' && verdict !== 'check',
  ...over,
});
const ref = (itemId: string, path: string): PileItemRefV1 => ({
  itemId,
  path,
  identity: { dev: '1', ino: '2', kind: 'directory' },
  collectedAt: 1,
  collectedBy: { accountId: 'a', kind: 'person' },
});

describe('collecting a row into the pile (the pile is the one authority, ruling 4)', () => {
  it('reads a row as collected, inside a collected folder, available, asking for a Keep confirmation, or without a box', () => {
    const pile = [
      ref('wt-1', '/repo/.dev/worktree/a'),
      ref('dir', '/Users/l/Library'),
    ];
    expect(
      describeStorageCollect(
        item('wt-1', '/repo/.dev/worktree/a', 'safe'),
        pile,
      ),
    ).toBe('collected');
    expect(
      describeStorageCollect(
        item('cache', '/Users/l/Library/Caches', 'safe'),
        pile,
      ),
    ).toBe('inside');
    // A sibling that only shares a prefix is not inside.
    expect(
      describeStorageCollect(item('lib2', '/Users/l/Library2', 'safe'), pile),
    ).toBe('available');
    expect(
      describeStorageCollect(item('win', 'C:\\Users\\l\\Library\\x', 'safe'), [
        ref('w', 'C:\\Users\\l\\Library'),
      ]),
    ).toBe('inside');
    expect(
      describeStorageCollect(
        item('wt-2', '/repo/.dev/worktree/b', 'caution'),
        pile,
      ),
    ).toBe('available');
    expect(describeStorageCollect(item('main', '/repo', 'keep'), pile)).toBe(
      'confirm',
    );
    expect(
      describeStorageCollect(item('home', '/Users/l', 'forbidden'), pile),
    ).toBe('none');
    expect(describeStorageCollect(item('dir', '/Users/l/Library', 'forbidden'), pile)).toBe('none');
    expect(
      describeStorageCollect(
        item('wt-3', '/repo/.dev/worktree/c', 'check'),
        pile,
      ),
    ).toBe('none');
    expect(
      describeStorageCollect(
        item('safe-no', '/x', 'safe', { collectable: false }),
        pile,
      ),
    ).toBe('none');
  });

  it('turns a tick into exactly one pile delta: add the row, remove its own entry, or nothing', () => {
    const pile = [ref('wt-1', '/repo/.dev/worktree/a')];
    const available = item('wt-2', '/repo/.dev/worktree/b', 'safe');
    const add = resolveStorageCollectToggle(available, pile);
    expect(add).toEqual({
      add: [{ itemId: 'wt-2', path: '/repo/.dev/worktree/b' }],
    });
    expect(
      resolveStorageCollectToggle(
        item('wt-1', '/repo/.dev/worktree/a', 'safe'),
        pile,
      ),
    ).toEqual({ remove: ['wt-1'] });
    expect(
      resolveStorageCollectToggle(
        item('kid', '/repo/.dev/worktree/a/node_modules', 'safe'),
        pile,
      ),
    ).toBeNull();
    expect(
      resolveStorageCollectToggle(item('home', '/Users/l', 'forbidden'), pile),
    ).toBeNull();
    expect(resolveStorageCollectToggle(item('wt-1', '/repo/.dev/worktree/a', 'forbidden'), pile)).toBeNull();
  });

  it('collects by served reference only: id and path travel, the machine reads identity and records who collected it', () => {
    expect(resolveStorageCollectToggle(item('wt-2', '/repo/b', 'safe'), [])).toEqual({
      add: [{ itemId: 'wt-2', path: '/repo/b' }],
    });
    expect(resolveStorageCollectAll([item('a', '/r/a', 'safe')], [])).toEqual({
      add: [{ itemId: 'a', path: '/r/a' }],
    });
  });

  it('ticks a group header for Safe only: mixed while part is collected, never sweeping Caution, Keep, Check or Forbidden', () => {
    const rows = [
      item('a', '/r/a', 'safe'),
      item('b', '/r/b', 'safe'),
      item('warn', '/r/warn', 'caution'),
      item('k', '/r/k', 'keep'),
      item('f', '/r/f', 'forbidden'),
      item('c', '/r/c', 'check'),
    ];
    expect(describeStorageGroupCollect(rows, [])).toBe('unchecked');
    expect(describeStorageGroupCollect(rows, [ref('a', '/r/a')])).toBe('mixed');
    expect(
      describeStorageGroupCollect(rows, [ref('a', '/r/a'), ref('b', '/r/b')]),
    ).toBe('checked');
    expect(
      describeStorageGroupCollect([item('k', '/r/k', 'keep')], []),
    ).toBeNull();
    const delta = resolveStorageCollectAll(rows, [ref('a', '/r/a')]);
    expect(delta?.add?.map((entry) => entry.itemId)).toEqual(['b']);
    expect(
      resolveStorageCollectAll(rows, [ref('a', '/r/a'), ref('b', '/r/b')]),
    ).toEqual({ remove: ['a', 'b'] });
  });
});

describe('the pile bar states (lab rs PM)', () => {
  const pile = (count: number, freesBytes: number) => ({
    count,
    freesBytes,
    droppedSinceLastView: [],
  });
  const applied = (
    outcomes: PileApplyResultV1['outcomes'],
    mode: PileApplyResultV1['mode'] = 'trash',
  ): PileApplyResultV1 => ({
    batchId: 'b1',
    mode,
    outcomes,
    inTrashBytes: mode === 'trash' ? 300 : 0,
    freedBytes: mode === 'delete' ? 300 : 0,
  });

  it('is absent until the pile holds something, then holds the count and what clearing frees', () => {
    expect(
      describeStoragePileBar({
        pile: pile(0, 0),
        receipt: null,
        checking: null,
      }),
    ).toEqual({ kind: 'hidden' });
    expect(
      describeStoragePileBar({ pile: null, receipt: null, checking: null }),
    ).toEqual({ kind: 'hidden' });
    expect(
      describeStoragePileBar({
        pile: pile(4, 5_800),
        receipt: null,
        checking: null,
      }),
    ).toEqual({ kind: 'ready', count: 4, freesBytes: 5_800 });
    expect(
      describeStoragePileBar({
        pile: pile(9, 1),
        receipt: null,
        checking: { count: 8, freesBytes: 7 },
      }),
    ).toEqual({ kind: 'checking', count: 8, freesBytes: 7 });
  });

  it('reads a Trash move as “in Trash” with how many were skipped, and only says freed when space returned', () => {
    const trash = applied([
      { itemId: 'a', status: 'moved' },
      { itemId: 'b', status: 'moved' },
      {
        itemId: 'c',
        status: 'skipped',
        reason: { code: 'changed_since_review' },
      },
      { itemId: 'd', status: 'refused', reason: { code: 'home_folder' } },
    ]);
    expect(
      describeStoragePileBar({
        pile: pile(0, 0),
        receipt: { kind: 'applied', result: trash, emptiesAt: 77 },
        checking: null,
      }),
    ).toEqual({
      kind: 'held',
      batchId: 'b1',
      count: 2,
      inTrashBytes: 300,
      notActed: 2,
      emptiesAt: 77,
    });
    const deleted = applied([{ itemId: 'a', status: 'deleted' }], 'delete');
    expect(
      describeStoragePileBar({
        pile: pile(0, 0),
        receipt: { kind: 'applied', result: deleted, emptiesAt: null },
        checking: null,
      }),
    ).toEqual({ kind: 'freed', count: 1, freedBytes: 300 });
    expect(
      describeStoragePileBar({
        pile: pile(2, 9),
        receipt: { kind: 'emptied', count: 2, freedBytes: 300 },
        checking: null,
      }),
    ).toEqual({ kind: 'freed', count: 2, freedBytes: 300 });
  });
});

describe('collecting a range (Shift, through the Collection range resolver)', () => {
  const rows = [item('a', '/r/a', 'safe'), item('b', '/r/b', 'safe'), item('k', '/r/k', 'keep'), item('f', '/r/f', 'forbidden'), item('c', '/r/c', 'caution'), item('d', '/r/d', 'safe')];
  it('adds Safe rows between the last tick and this one, leaving Caution for an explicit tick', () => {
    const delta = resolveStorageCollectRange({ rows, pile: [ref('a', '/r/a')], anchorKey: 'a', targetKey: 'd' });
    expect(delta?.add?.map((entry) => entry.itemId)).toEqual(['b', 'd']);
    expect(delta?.remove).toBeUndefined();
  });
  it('takes the range out when the target is already collected, and is one plain tick without an anchor', () => {
    const pile = [ref('a', '/r/a'), ref('b', '/r/b'), ref('c', '/r/c')];
    expect(resolveStorageCollectRange({ rows, pile, anchorKey: 'd', targetKey: 'b' })).toEqual({ remove: ['b'] });
    expect(resolveStorageCollectRange({ rows, pile: [], anchorKey: null, targetKey: 'd' })?.add?.map((entry) => entry.itemId)).toEqual(['d']);
    expect(resolveStorageCollectRange({ rows, pile: [], anchorKey: 'a', targetKey: 'k' })).toBeNull();
  });
});
