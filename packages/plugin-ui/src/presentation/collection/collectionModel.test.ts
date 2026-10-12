import { describe, expect, it } from 'vitest';

import {
  createHappierCollectionVisitMemory,
  deriveHappierCollectionSections,
  deriveHappierCollectionTree,
  resolveHappierCollectionInitialKey,
  resolveHappierCollectionKeyCommand,
} from './collectionModel.js';
import { resolveHappierCollectionIndexView } from './collectionLayout.js';

type Thing = Readonly<{ id: string; group: 'a' | 'b'; rank: number }>;

const things: readonly Thing[] = [
  { id: 'x', group: 'b', rank: 2 },
  { id: 'y', group: 'a', rank: 3 },
  { id: 'z', group: 'a', rank: 1 },
];
const keyOf = (thing: Thing) => thing.id;

describe('Collection sections', () => {
  it('groups along the declared axis in axis order, sorts inside each group and drops empty groups', () => {
    const sections = deriveHappierCollectionSections({
      items: things,
      keyOf,
      groups: {
        axis: [{ key: 'a', title: 'A' }, { key: 'c', title: 'C' }, { key: 'b', title: 'B' }],
        groupOf: (thing) => thing.group,
      },
      order: (left, right) => left.rank - right.rank,
    });
    expect(sections.map((section) => [section.group?.key, section.items.map(keyOf)])).toEqual([
      ['a', ['z', 'y']],
      ['b', ['x']],
    ]);
  });

  it('keeps the caller\'s array when nothing groups, orders or narrows it', () => {
    const sections = deriveHappierCollectionSections({ items: things, keyOf });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.group).toBeNull();
    expect(sections[0]!.items).toBe(things);
  });

  it('filters inside the loaded window and refuses duplicate identities', () => {
    expect(deriveHappierCollectionSections({ items: things, keyOf, filter: (thing) => thing.group === 'b' })[0]!.items)
      .toEqual([things[0]]);
    expect(() => deriveHappierCollectionSections({ items: [...things, things[0]!], keyOf }))
      .toThrow(/duplicate key "x"/u);
  });
});

describe('Collection initial selection (wide screens always have one)', () => {
  it('lands on the last visited item while it is still listed, else on the first', () => {
    expect(resolveHappierCollectionInitialKey({ keys: ['a', 'b', 'c'], lastVisited: 'b' })).toBe('b');
    expect(resolveHappierCollectionInitialKey({ keys: ['a', 'b', 'c'], lastVisited: 'gone' })).toBe('a');
    expect(resolveHappierCollectionInitialKey({ keys: ['a'], lastVisited: null })).toBe('a');
    expect(resolveHappierCollectionInitialKey({ keys: [], lastVisited: 'b' })).toBeNull();
  });

  it('keeps each collection\'s last visit apart', () => {
    const hosts = createHappierCollectionVisitMemory<string>();
    const teams = createHappierCollectionVisitMemory<string>();
    hosts.record('host-a');
    teams.record('team-b');
    hosts.record('host-c');
    expect([hosts.read(), teams.read()]).toEqual(['host-c', 'team-b']);
  });
});

describe('Collection index route', () => {
  it('lands beside the list, is the list when stacked or outside a Collection, and waits for the first measurement', () => {
    expect(resolveHappierCollectionIndexView({ mode: 'split' })).toBe('land');
    expect(resolveHappierCollectionIndexView({ mode: 'stacked' })).toBe('list');
    expect(resolveHappierCollectionIndexView(null)).toBe('list');
    expect(resolveHappierCollectionIndexView({ mode: 'measuring' })).toBe('pending');
  });
});

describe('Collection list keyboard', () => {
  const base = { keys: ['a', 'b', 'c'], focusKey: 'b', openKey: 'a', expandable: false, rtl: false } as const;

  it('moves focus with arrows and j/k without opening, and wraps like every roving collection', () => {
    expect(resolveHappierCollectionKeyCommand({ ...base, key: 'ArrowDown' })).toEqual({ kind: 'focus', key: 'c' });
    expect(resolveHappierCollectionKeyCommand({ ...base, key: 'k' })).toEqual({ kind: 'focus', key: 'a' });
    expect(resolveHappierCollectionKeyCommand({ ...base, key: 'End' })).toEqual({ kind: 'focus', key: 'c' });
    expect(resolveHappierCollectionKeyCommand({ ...base, focusKey: 'c', key: 'j' })).toEqual({ kind: 'focus', key: 'a' });
  });

  it('starts from the open item when nothing has focus yet', () => {
    expect(resolveHappierCollectionKeyCommand({ ...base, focusKey: null, key: 'ArrowDown' }))
      .toEqual({ kind: 'focus', key: 'b' });
  });

  it('opens with Enter, peeks with Space only where peek exists, and closes with Escape', () => {
    expect(resolveHappierCollectionKeyCommand({ ...base, key: 'Enter' })).toEqual({ kind: 'open', key: 'b' });
    expect(resolveHappierCollectionKeyCommand({ ...base, key: ' ' })).toBeNull();
    expect(resolveHappierCollectionKeyCommand({ ...base, expandable: true, key: ' ' }))
      .toEqual({ kind: 'toggleExpanded', key: 'b' });
    expect(resolveHappierCollectionKeyCommand({ ...base, key: 'Escape' })).toEqual({ kind: 'close' });
    expect(resolveHappierCollectionKeyCommand({ ...base, openKey: null, key: 'Escape' })).toBeNull();
  });
});

describe('Collection tree', () => {
  type Node = Readonly<{ id: string; group: 'a' | 'b'; parent: string | null; rank: number }>;
  const nodeKey = (node: Node) => node.id;
  const grouping = { axis: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }], groupOf: (node: Node) => node.group };

  it('flattens each group depth-first with the caller\'s order among siblings, rooting foreign and cyclic parents', () => {
    const nodes: readonly Node[] = [
      { id: 'late-child', group: 'a', parent: 'owner', rank: 2 },
      { id: 'owner', group: 'a', parent: null, rank: 9 },
      { id: 'early-child', group: 'a', parent: 'owner', rank: 1 },
      { id: 'grandchild', group: 'a', parent: 'early-child', rank: 0 },
      // The parent lives in another group, so this row is that group's owner.
      { id: 'stray', group: 'b', parent: 'owner', rank: 0 },
      // A loop the caller reported: its first member becomes a root instead of vanishing.
      { id: 'loop-1', group: 'b', parent: 'loop-2', rank: 1 },
      { id: 'loop-2', group: 'b', parent: 'loop-1', rank: 2 },
    ];
    const { sections, tree } = deriveHappierCollectionTree({
      items: nodes, keyOf: nodeKey, groups: grouping, parentKey: (node) => node.parent,
      order: (left, right) => left.rank - right.rank,
    });
    expect(sections.map((section) => section.items.map(nodeKey))).toEqual([
      ['owner', 'early-child', 'grandchild', 'late-child'],
      ['stray', 'loop-1', 'loop-2'],
    ]);
    expect(tree?.get('grandchild')).toMatchObject({ depth: 2, parentKey: 'early-child', posInSet: 1, setSize: 1 });
    expect(tree?.get('late-child')).toMatchObject({ depth: 1, posInSet: 2, setSize: 2 });
    expect(tree?.get('owner')).toMatchObject({ childCount: 2, held: false, context: false });
    expect(tree?.get('stray')).toMatchObject({ depth: 0, parentKey: null });
    expect(tree?.get('loop-2')).toMatchObject({ depth: 1, parentKey: 'loop-1' });
  });

  it('holds open only owners the filter narrows inside, and keeps non-matching owners as context', () => {
    const nodes: readonly Node[] = [
      { id: 'owner', group: 'a', parent: null, rank: 0 },
      { id: 'match', group: 'a', parent: 'owner', rank: 0 },
      { id: 'miss', group: 'a', parent: 'owner', rank: 0 },
      { id: 'whole', group: 'a', parent: null, rank: 0 },
      { id: 'whole-child', group: 'a', parent: 'whole', rank: 0 },
    ];
    const { sections, tree } = deriveHappierCollectionTree({
      items: nodes, keyOf: nodeKey, parentKey: (node) => node.parent,
      filter: (node) => node.id !== 'miss' && node.id !== 'owner',
    });
    expect(sections[0]!.items.map(nodeKey)).toEqual(['owner', 'match', 'whole', 'whole-child']);
    expect(tree?.get('owner')).toMatchObject({ context: true, held: true, childCount: 1 });
    // Everything under it matches: the reader's own open state decides.
    expect(tree?.get('whole')).toMatchObject({ context: false, held: false });
  });
});
