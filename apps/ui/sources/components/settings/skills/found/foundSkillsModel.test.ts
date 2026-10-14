import { describe, expect, it } from 'vitest';
import { SkillFoundListResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  FOUND_FOLD_ROWS,
  foldFoundRows,
  foundAddAllItems,
  foundRowKind,
  orderFoundRows,
  partitionFoundMachines,
  resolveFoundMachineBody,
} from './foundSkillsModel';

const result = SkillFoundListResultV1Schema.parse({
  scannedAt: 1,
  roots: [],
  items: [
    { name: 'held', description: null, path: '/s/held', digest: 'a', agents: ['claude'], scope: 'user', inLibrary: 'held', masksLibrary: false, happierInstalled: false, pluginOwned: null },
    { name: 'plug', description: null, path: '/p/plug', digest: 'b', agents: ['claude'], scope: 'plugin', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: { pluginName: 'frontend' } },
    { name: 'same-name', description: null, path: '/s/same-name', digest: 'c', agents: ['codex'], scope: 'user', inLibrary: null, masksLibrary: true, happierInstalled: false, pluginOwned: null },
    { name: 'plain', description: null, path: '/s/plain', digest: 'd', agents: ['claude'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
    { name: 'plain-2', description: null, path: '/s/plain-2', digest: 'e', agents: ['claude'], scope: 'user', inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null },
  ],
});
const byName = (name: string) => result.items.find((item) => item.name === name)!;

describe('Found rows', () => {
  it('offers each row exactly one thing, whatever else is true of it', () => {
    expect(result.items.map((item) => [item.name, foundRowKind(item)])).toEqual([
      ['held', 'in_library'], ['plug', 'plugin'], ['same-name', 'masks'], ['plain', 'addable'], ['plain-2', 'addable'],
    ]);
    // A copy the library already holds wins over a same-name warning.
    expect(foundRowKind({ ...byName('same-name'), inLibrary: 'x' })).toBe('in_library');
  });

  it('puts masked names first and otherwise keeps scan order, so an added row stays put', () => {
    expect(orderFoundRows(result.items).map((item) => item.name)).toEqual(['same-name', 'held', 'plug', 'plain', 'plain-2']);
    const added = result.items.map((item) => (item.name === 'plain' ? { ...item, inLibrary: 'plain' } : item));
    expect(orderFoundRows(added).map((item) => item.name)).toEqual(['same-name', 'held', 'plug', 'plain', 'plain-2']);
  });

  it('adds all only the rows that offer Add to library', () => {
    expect(foundAddAllItems(result.items).map((item) => item.name)).toEqual(['plain', 'plain-2']);
  });

  it('folds a long list to a head and a count, and never hides a single row behind "1 more"', () => {
    const rows = Array.from({ length: FOUND_FOLD_ROWS + 5 }, (_, index) => index);
    expect(foldFoundRows(rows, false)).toEqual({ shown: rows.slice(0, FOUND_FOLD_ROWS), hidden: 5 });
    expect(foldFoundRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    const justOver = Array.from({ length: FOUND_FOLD_ROWS + 1 }, (_, index) => index);
    expect(foldFoundRows(justOver, false)).toEqual({ shown: justOver, hidden: 0 });
  });
});

describe('Found machine sections', () => {
  const scan = (over: Partial<Parameters<typeof resolveFoundMachineBody>[0]>) => ({ machineId: 'm', result: null, scanning: false, failure: null, ...over });

  it('says what it is doing before anything is known, and keeps the last known rows through a failed read', () => {
    expect(resolveFoundMachineBody(scan({}))).toEqual({ kind: 'looking' });
    expect(resolveFoundMachineBody(scan({ failure: 'failed' }))).toEqual({ kind: 'failed' });
    expect(resolveFoundMachineBody(scan({ failure: 'older_machine', result }))).toEqual({ kind: 'older_machine' });
    expect(resolveFoundMachineBody(scan({ failure: 'failed', result }))).toMatchObject({ kind: 'rows' });
    expect(resolveFoundMachineBody(scan({ result: { ...result, items: [] } }))).toEqual({ kind: 'empty' });
  });

  it('names offline machines nothing is known about once, as a count, and keeps every other machine', () => {
    const machines = [
      { id: 'on', offline: false }, { id: 'off-known', offline: true }, { id: 'off-unknown-1', offline: true }, { id: 'off-unknown-2', offline: true },
    ];
    const { sections, unseenOffline } = partitionFoundMachines(machines, (machine) =>
      scan({ machineId: machine.id, result: machine.id === 'off-known' || machine.id === 'on' ? result : null }));
    expect(sections.map((machine) => machine.id)).toEqual(['on', 'off-known']);
    expect(unseenOffline).toBe(2);
  });
});
