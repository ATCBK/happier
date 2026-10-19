import { afterEach, describe, expect, it } from 'vitest';
import {
  readBuiltinWidgetDescriptorV1,
  WidgetAreaPresetV1Schema,
  flattenWidgetLayoutWidgetsV1,
  applyWidgetLayoutItemIntentV1,
  WidgetLayoutItemsV1StoredSchema,
  captureWidgetLayoutFragmentGroupV1,
  instantiateWidgetLayoutFragmentGroupV1,
} from '@happier-dev/protocol/widgets';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { readWidgetGroupTitle } from '@/components/widgets/group/widgetGroupTitle';

import { createMachinesWidgetPresets, selectMachinesPresetMachine } from './machinesWidgetPresets';

const names = { overview: 'Overview', machineHealth: 'Machine health' };

describe('createMachinesWidgetPresets', () => {
  afterEach(() => setPreferredLanguageFromSettings(null));

  it('translates a materialized preset in the current language, while renamed groups stay literal', async () => {
    setPreferredLanguageFromSettings('en');
    await preloadTranslations();
    const [preset] = createMachinesWidgetPresets(names, { machine: null });
    const items = WidgetLayoutItemsV1StoredSchema.parse(JSON.parse(JSON.stringify(preset!.items)));
    const group = items[0];
    if (group?.kind !== 'group') throw new Error('expected the machine group');
    expect(readWidgetGroupTitle(group)).toBe(t('machines.widgets.body.presets.machineHealth'));

    setPreferredLanguageFromSettings('es');
    await preloadTranslations();
    const spanishTitle = t('machines.widgets.body.presets.machineHealth');
    expect(spanishTitle).not.toBe(names.machineHealth);
    expect(readWidgetGroupTitle(group)).toBe(spanishTitle);
    const copied = instantiateWidgetLayoutFragmentGroupV1(captureWidgetLayoutFragmentGroupV1(group), {
      groupId: 'copy', childIds: ['copy:0', 'copy:1', 'copy:2'],
    });
    expect(readWidgetGroupTitle(copied)).toBe(spanishTitle);

    const renamed = applyWidgetLayoutItemIntentV1(items, { kind: 'rename', instanceId: group.id, displayName: 'My machines' })[0];
    if (renamed?.kind !== 'group') throw new Error('expected the renamed group');
    setPreferredLanguageFromSettings('en');
    expect(readWidgetGroupTitle(renamed)).toBe('My machines');
    setPreferredLanguageFromSettings('es');
    expect(readWidgetGroupTitle(renamed)).toBe('My machines');

    const untitled = applyWidgetLayoutItemIntentV1(items, { kind: 'rename', instanceId: group.id, displayName: null })[0];
    if (untitled?.kind !== 'group') throw new Error('expected the untitled group');
    expect(readWidgetGroupTitle(untitled)).toBeUndefined();
  });

  it('keeps historical literal titles and unknown stored fields readable without translating custom names', () => {
    const [preset] = createMachinesWidgetPresets(names, { machine: null });
    const item = preset!.items[0];
    if (item?.kind !== 'group') throw new Error('expected the machine group');
    const { titleKey: _preset, ...literal } = item;
    expect(WidgetAreaPresetV1Schema.safeParse({ ...preset, items: [{ ...literal, futureDecoration: 'ignored' }] }).success).toBe(false);
    const [read] = WidgetLayoutItemsV1StoredSchema.parse([{ ...literal, futureDecoration: 'ignored' }]);
    if (read?.kind !== 'group') throw new Error('expected the stored group');
    expect(read).toEqual(literal);
    setPreferredLanguageFromSettings('es');
    expect(readWidgetGroupTitle(read)).toBe(names.machineHealth);
    expect(readWidgetGroupTitle({ ...read, titleKey: 'retired.preset.title' })).toBe(names.machineHealth);
  });
  it('opens with a group of the pinned machine, then Activity across every machine; the page owns the needs-you list (plan 60 D5, amended)', () => {
    const [preset] = createMachinesWidgetPresets(names, {
      machine: { serverId: 'home-1', machineId: 'edge-1' },
    });
    expect(WidgetAreaPresetV1Schema.safeParse(preset).success).toBe(true);
    const items = WidgetAreaPresetV1Schema.parse(preset).items;
    expect(
      items.map((item) =>
        item.kind === 'widget'
          ? item.instance.definition
          : { group: item.title },
      ),
    ).toEqual([
      { group: 'Machine health' },
      { kind: 'builtin', id: 'machine_activity' },
    ]);
    const group = items[0];
    if (group?.kind !== 'group') throw new Error('expected the machine group');
    expect(group.context).toEqual({
      machine: {
        kind: 'value',
        value: { serverId: 'home-1', machineId: 'edge-1' },
      },
    });
    expect(
      group.children.map((child) => [
        child.instance.definition,
        child.instance.bindings.machine,
      ]),
    ).toEqual([
      [
        { kind: 'builtin', id: 'machine_vitals' },
        { kind: 'context', slot: 'machine' },
      ],
      [
        { kind: 'builtin', id: 'machine_guard' },
        { kind: 'context', slot: 'machine' },
      ],
      [
        { kind: 'builtin', id: 'machine_storage' },
        { kind: 'context', slot: 'machine' },
      ],
    ]);
    const activity = items[1];
    expect(
      activity?.kind === 'widget'
        ? activity.instance.bindings.machine
        : 'missing',
    ).toBeUndefined();
  });

  it('places every widget at a size its definition declares, with unique placement identities', () => {
    const [preset] = createMachinesWidgetPresets(names, {
      machine: { serverId: 'home-1', machineId: 'nl2' },
    });
    const widgets = flattenWidgetLayoutWidgetsV1(
      WidgetAreaPresetV1Schema.parse(preset).items,
    );
    for (const widget of widgets) {
      const descriptor = readBuiltinWidgetDescriptorV1(
        widget.instance.definition,
      );
      expect(descriptor?.sizeDeclaration.sizes).toContain(widget.size);
    }
    expect(new Set(widgets.map((widget) => widget.instance.id)).size).toBe(
      widgets.length,
    );
  });

  it('keeps the health group available to organize while the Home has no machine to pin', () => {
    const [preset] = createMachinesWidgetPresets(names, { machine: null });
    const items = WidgetAreaPresetV1Schema.parse(preset).items;
    expect(
      items.map((item) =>
        item.kind === 'widget'
          ? item.instance.definition.kind === 'builtin' &&
            item.instance.definition.id
          : item.kind,
      ),
    ).toEqual(['group', 'machine_activity']);
    const group = items[0];
    if (group?.kind !== 'group') throw new Error('expected the machine group');
    expect(group.context?.machine).toBeUndefined();
    expect(group.children).toHaveLength(3);
  });
});

describe('selectMachinesPresetMachine', () => {
  const key = (serverId: string, machineId: string) => JSON.stringify([serverId, machineId]);
  const edge = { serverId: 'home', machineId: 'edge' };
  const studio = { serverId: 'home', machineId: 'studio' };

  it('pins the machine that needs the person, then this computer, then an online machine (never an unbound preset)', () => {
    const nl2 = { serverId: 'home', machineId: 'nl2' };
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [nl2], thisComputerMachineId: 'mbp', reportingMachineKeys: [], fleet: { firstOnline: edge, first: studio } })).toEqual(nl2);
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: 'mbp', reportingMachineKeys: [], fleet: { firstOnline: edge, first: studio } }))
      .toEqual({ serverId: 'home', machineId: 'mbp' });
    // A browser is no machine. An offline machine's last publication still says "reporting": online wins over it.
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: null, reportingMachineKeys: [key('home', 'studio')], fleet: { firstOnline: edge, first: studio } }))
      .toEqual(edge);
    // Every machine is away: one that reported, else the fleet's first machine, still binds the group.
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: null, reportingMachineKeys: [key('home', 'nl2')], fleet: { firstOnline: null, first: studio } }))
      .toEqual({ serverId: 'home', machineId: 'nl2' });
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: null, reportingMachineKeys: [], fleet: { firstOnline: null, first: studio } }))
      .toEqual(studio);
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: null, reportingMachineKeys: [] })).toBeNull();
  });

  it('passes over this computer while it is offline and another machine is online', () => {
    const fleet = { firstOnline: edge, first: studio, onlineKeys: [key('home', 'edge')] };
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: 'studio', reportingMachineKeys: [key('home', 'studio')], fleet }))
      .toEqual(edge);
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: 'edge', reportingMachineKeys: [], fleet }))
      .toEqual(edge);
    // With nothing online, this computer is still the natural pin.
    expect(selectMachinesPresetMachine({ presenceLoaded: true, serverId: 'home', needsYou: [], thisComputerMachineId: 'studio', reportingMachineKeys: [],
      fleet: { firstOnline: null, first: edge, onlineKeys: [] } })).toEqual(studio);
  });

  it('binds a known online machine while another Home census is still loading', () => {
    expect(selectMachinesPresetMachine({ presenceLoaded: false, serverId: 'home', needsYou: [],
      thisComputerMachineId: 'studio', reportingMachineKeys: [key('home', 'studio')],
      fleet: { firstOnline: edge, first: studio, onlineKeys: [key('home', 'edge')] } })).toEqual(edge);
  });
});
