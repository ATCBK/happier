import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { recordMachineCollectionVisit } from './collection/machineCollectionVisit';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type Group = {
  serverId: string;
  serverName: string;
  status: 'idle' | 'loading' | 'signedOut' | 'error';
  machines: Array<{
    id: string;
    active: boolean;
    activeAt: number;
    metadata?: { displayName?: string; host?: string; platform?: string };
  }>;
};

const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const desktopState = vi.hoisted(() => ({ value: false }));
const viewModelState = vi.hoisted(() => ({
  value: null as unknown as {
    activeServerId: string;
    allMachines: Group['machines'];
    hasMachines: boolean;
    isLoadingMachines: boolean;
    machineRows: unknown[];
    showMachinesGroupedByServer: boolean;
    visibleMachineGroups: Group[];
    managedByServerId?: Readonly<Record<string, readonly ManagedMachineV1[]>>;
    managedInventory?: {
      entries: Record<
        string,
        { status: 'error' | 'denied'; errorCode: string }
      >;
      accountScopes: ReadonlyMap<
        string,
        { resolution: { kind: 'unavailable' } }
      >;
      refresh(): void;
    };
  },
}));
const syncBoundary = vi.hoisted(() => ({
  refreshMachines: vi.fn(async () => undefined),
}));
// The sync singleton is the transport boundary; the list only asks it to read the machines again.
vi.mock('@/sync/sync', () => ({
  sync: { refreshMachines: syncBoundary.refreshMachines },
}));
const poolFeatureState = vi.hoisted(() => ({
  value: 'disabled' as 'disabled' | 'enabled',
}));
const relayDriftState = vi.hoisted(() => ({
  value: null as null | { title: string; description: string },
}));

installMachinesSettingsCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Pressable: 'Pressable',
      Platform: {
        OS: 'web',
        select: (options: Record<string, unknown>) =>
          options?.web ?? options?.default,
      },
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { push: routerPushSpy, replace: routerReplaceSpy },
      pathname: '/settings/machines',
    }).module;
  },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
  isDesktopHost: () => desktopState.value,
}));
vi.mock('@/components/ui/icons/Icon', () => ({
  Icon: 'Icon',
  ICON_SIZE: { xs: 12 },
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({
    children,
    title,
    description,
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
  }) => React.createElement('Group', { title, description }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/forms/SelectionTiles', () => ({
  SelectionTiles: (props: Record<string, unknown>) =>
    React.createElement('SelectionTiles', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: Record<string, unknown>) =>
    React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/settings/shell/SettingsPageHeader', () => ({
  SettingsPageHeader: (props: { actions?: React.ReactNode }) =>
    React.createElement('SettingsPageHeader', props, props.actions),
}));
// Detected-CLI glyphs read the machine's capabilities over RPC; this screen only places them.
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
  MachineCliGlyphs: () => null,
}));
// The Home's pool feature decision and rows come from the network-backed projection owner.
vi.mock('@/sync/engine/machines/useMachinePoolProjections', () => ({
  useMachinePoolProjections: (groups: ReadonlyArray<{ serverId: string }>) =>
    groups.map((group) => ({
      serverId: group.serverId,
      accountId: 'account-a',
      featureStatus: poolFeatureState.value,
      featureEnabled: poolFeatureState.value === 'enabled',
      pools: [],
      status: 'idle',
      ready: true,
    })),
}));
vi.mock('./machinesSettingsViewModel', () => ({
  useMachinesSettingsViewModel: () => viewModelState.value,
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
  useRelayDriftBanner: () => relayDriftState.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
  RelayDriftActionCard: (props: Record<string, unknown>) =>
    React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/ui/lists/AttentionBanner', () => ({
  AttentionBanner: (props: Record<string, unknown>) =>
    React.createElement('AttentionBanner', props),
}));

// Keep cold module collection outside an individual behavior test's runtime budget.
const { AllMachinesIndex: MachinesSettingsView } =
  await import('@/components/machines/index/AllMachinesIndex');
const { MachinesRelayDriftBanner } = await import('./MachinesRelayDriftBanner');

function machine(id: string, displayName: string, host: string) {
  // `activeAt: 0` leaves presence to `active`, so a slow run cannot age the machine offline.
  return {
    id,
    active: true,
    activeAt: 0,
    metadata: { displayName, host, platform: 'darwin' },
  };
}

function setMachines(
  groups: Group[],
  overrides: Partial<typeof viewModelState.value> = {},
) {
  const allMachines = groups.flatMap((group) => group.machines);
  viewModelState.value = {
    activeServerId: groups[0]?.serverId ?? 'srv-a',
    allMachines,
    hasMachines: allMachines.length > 0,
    isLoadingMachines: false,
    machineRows: [],
    showMachinesGroupedByServer: groups.length > 1,
    // The real projection supplies authenticated Home/Account custody; presence alone is not admission.
    visibleMachineGroups: groups.map(group => ({ ...group,
      accountScope: { serverId: group.serverId, accountId: 'account-a' },
    })),
    ...overrides,
  };
}

async function renderPage() {
  return (await renderScreen(React.createElement(MachinesSettingsView))).tree;
}

function addMenuItemIds(
  tree: Awaited<ReturnType<typeof renderPage>>,
): string[] {
  const menu = tree.findByType('DropdownMenu' as never) as unknown as {
    props: { items: Array<{ id: string }> };
  };
  return menu.props.items.map((item) => item.id);
}

describe('All machines (the Settings door index)', () => {
  beforeEach(() => {
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    desktopState.value = false;
    poolFeatureState.value = 'disabled';
    relayDriftState.value = null;
    recordMachineCollectionVisit({
      machineId: 'machine-a1',
      serverId: 'srv-a',
      query: '',
    });
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
    ]);
  });

  it('lists the machines and opens a machine in the collection, scoped to its Home', async () => {
    const tree = await renderPage();

    const row = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.machine:srv-a:machine-a1' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    expect(row.props.accessibilityLabel).toContain('Machine A1');
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/machine-a1?serverId=srv-a',
    );
    // No desktop-only row on the web.
    expect(
      tree.findAll(
        (node) => node.props?.testID === 'settings.machines.thisComputer',
      ),
    ).toHaveLength(0);
  });

  it('says the fleet in one sentence and lists the machine that needs you, with its one action, above the table', async () => {
    const resources = {
      v: 1,
      vitals: { state: 'reporting' },
      host: { logicalCores: 8, memoryTotalBytes: 2 ** 34, bootedAt: 1 },
      attention: {
        level: 'needs_you',
        reasons: [
          {
            key: 'disk',
            level: 'needs_you',
            since: Date.now() - 60_000,
            metric: 'disk',
            nextStep: 'free_up_space',
            kind: 'disk_full',
            volumeId: 'v',
            volumeLabel: '/data',
          },
        ],
      },
    };
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [
          {
            ...machine('machine-a1', 'Machine A1', 'a.local'),
            daemonState: { resources },
          } as never,
          machine('machine-a2', 'Machine A2', 'b.local'),
        ],
      },
    ]);
    const tree = await renderPage();
    const header = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.header' &&
        typeof node.props?.title === 'string',
    )[0]!;
    expect(header.props.title).toContain('machineAttention.phrases.diskFull');
    // This file mocks Item, so the row's one action is read from the row it belongs to.
    const row = tree.findAll(
      (node) => node.props?.testID === 'machines.needs-you.srv-a.machine-a1',
    )[0]!;
    const action = (
      row.props.rightElement as React.ReactElement<{
        children: React.ReactElement<{ onPress: () => void }>;
      }>
    ).props.children;
    await act(async () => {
      action.props.onPress();
    });
    // "Free up space" opens Storage prepared for the disk the reason names (plan 40 STO-23).
    expect(routerPushSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/settings\/machines\/machine-a1\?serverId=srv-a&tab=storage&.*prepare=lowDisk/u,
      ),
    );
    expect(routerPushSpy.mock.calls.at(-1)?.[0]).toContain('volumeId=v');
  });

  it('opens retained pending compute in the same Home without ordinary Machine RPC glyphs', async () => {
    const row: ManagedMachineV1 = {
      id: 'pending',
      homeId: 'home-a',
      custodianAccountId: 'owner',
      launch: {
        provider: { pluginId: 'custom.provisioner', localId: 'native' },
        schemaVersion: 1,
        name: 'Build box',
        choices: {},
      },
      controller: { machineId: 'controller', installationId: 'installation' },
      allocation: 'may-exist',
      creationState: 'active',
      desired: 'start',
      desiredWhen: 'now',
      intentRevision: 1,
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
    };
    setMachines(
      [
        {
          serverId: 'srv-a',
          serverName: 'Home A',
          status: 'idle',
          machines: [],
        },
      ],
      { hasMachines: true, managedByServerId: { 'srv-a': [row] } },
    );
    const tree = await renderPage();
    const pending = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.managed:srv-a:pending' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(pending);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/managed/pending?serverId=srv-a',
    );
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('does not present an unreadable managed inventory as an empty Home', async () => {
    setMachines(
      [
        {
          serverId: 'srv-a',
          serverName: 'Home A',
          status: 'idle',
          machines: [],
        },
      ],
      {
        managedInventory: {
          entries: {
            'srv-a': { status: 'error', errorCode: 'managed_request_failed' },
          },
          accountScopes: new Map(),
          refresh: () => undefined,
        },
      },
    );
    const tree = await renderPage();
    expect(
      tree.findAll(
        (node) => node.props?.testID === 'settings.machines.managed.read.srv-a',
      ).length,
    ).toBeGreaterThan(0);
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('restores the collection search after opening a row and returning on a phone', async () => {
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: Array.from({ length: 9 }, (_, index) =>
          machine(
            `machine-${index}`,
            index === 0 ? 'Build box' : `Laptop ${index}`,
            `host-${index}.local`,
          ),
        ),
      },
    ]);
    const tree = await renderPage();
    const search = tree.findAll(
      (node) => node.props?.testID === 'machines.index.search',
    )[0]!;
    await act(async () => search.props.onChangeText('Build'));
    const selected = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.machine:srv-a:machine-0' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(selected);
    });
    const returned = await renderPage();
    expect(
      returned.findAll(
        (node) => node.props?.testID === 'machines.index.search',
      )[0]!.props.value,
    ).toBe('Build');
    expect(
      returned.findAll(
        (node) =>
          node.props?.testID === 'machines.index.row.machine:srv-a:machine-1',
      ),
    ).toHaveLength(0);
  });

  it("keeps a long fleet's offline machines out of the table until asked for, and finds them by search", async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline],
      },
    ]);
    const tree = await renderPage();
    const visible = (key: string) =>
      tree.findAll(
        (node) =>
          node.props?.testID === `machines.index.row.machine:srv-a:${key}`,
      ).length > 0;

    expect(visible('machine-a1')).toBe(true);
    expect(visible('old-0')).toBe(false);
    const show = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.offline-action' &&
        typeof node.props?.onPress === 'function',
    )[0];
    expect(show).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(show!);
    });
    expect(visible('old-0')).toBe(true);

    // A search reaches every machine, whatever the fold says.
    const fresh = await renderPage();
    const search = fresh.findAll(
      (node) => node.props?.testID === 'machines.index.search',
    )[0]!;
    await act(async () => search.props.onChangeText('Old 3'));
    expect(
      fresh.findAll(
        (node) =>
          node.props?.testID === 'machines.index.row.machine:srv-a:old-3',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('opens the canonical add-machine draft from both the browser and desktop collection', async () => {
    const webTree = await renderPage();
    expect(addMenuItemIds(webTree)).toEqual(['machine', 'preset']);

    desktopState.value = true;
    const desktopTree = await renderPage();
    expect(addMenuItemIds(desktopTree)).toEqual(['machine', 'preset']);
    const menu = desktopTree.findByType('DropdownMenu' as never) as unknown as {
      props: { onSelect: (id: string) => void };
    };
    await act(async () => menu.props.onSelect('machine'));
    expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/add');
  });

  it('lists this computer in the desktop app and opens its page in the collection', async () => {
    desktopState.value = true;
    const tree = await renderPage();

    const row = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.thisComputer',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/this-computer',
    );
  });

  it('shows the ways to add a machine when there are none, and offers a pool where the Home supports pools', async () => {
    setMachines([
      { serverId: 'srv-a', serverName: 'Home A', status: 'idle', machines: [] },
    ]);
    poolFeatureState.value = 'enabled';
    const tree = await renderPage();

    const tiles = tree.findByType('SelectionTiles' as never) as unknown as {
      props: { options: Array<{ id: string }>; onPress: (id: string) => void };
    };
    // The pool is added from its own section, so the tiles do not offer it twice.
    expect(tiles.props.options.map((option) => option.id)).toEqual(['machine']);
    expect(addMenuItemIds(tree)).toEqual(['machine', 'preset', 'pool']);
    const menu = tree.findByType('DropdownMenu' as never) as unknown as {
      props: { onSelect: (id: string) => void };
    };
    await act(async () => menu.props.onSelect('pool'));
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/pools/new?serverId=srv-a',
    );
  });

  it('holds the collection loading, not the add tiles, while the first machine list loads', async () => {
    setMachines(
      [
        {
          serverId: 'srv-a',
          serverName: 'Home A',
          status: 'loading',
          machines: [],
        },
      ],
      { isLoadingMachines: true },
    );
    const tree = await renderPage();

    expect(
      tree.findAll(
        (node) =>
          node.props?.testID === 'machines.index.collection' &&
          node.props?.loading === true,
      ).length,
    ).toBeGreaterThan(0);
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('ends in a named failure with Retry, not the add tiles, when the Home cannot list its machines', async () => {
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'error',
        machines: [],
      },
    ]);
    const tree = await renderPage();

    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
    const titles = tree
      .findAllByType('Item' as never)
      .map(
        (node) => (node as unknown as { props: { title: string } }).props.title,
      );
    expect(titles).not.toContain('common.loading');
    const failure = tree.find(
      (node) => node.props?.testID === 'settings.machines.unreadable',
    ) as unknown as {
      props: {
        title: string;
        rightElement: { props: { testID: string; onPress: () => void } };
      };
    };
    expect(failure.props.title).toContain('settingsMachines.unreadableTitle');
    const retry = failure.props.rightElement;
    expect(retry.props.testID).toBe('settings.machines.unreadable.retry');
    // The Action/HTTP refresh journey is exercised with the real Account binding in machinesList.refresh.test.tsx.
  });

  it('groups machines by Home when several Homes are shown, keeping a Home that has none', async () => {
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
      {
        serverId: 'srv-b',
        serverName: 'Home B',
        status: 'signedOut',
        machines: [],
      },
    ]);
    const tree = await renderPage();

    const collection = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.collection' && node.props?.model,
    )[0]!;
    const groups = (
      collection.props.model.sections as Array<{
        group: { title: string; description?: string } | null;
      }>
    ).map((section) => section.group);
    expect(groups.map((group) => group?.title)).toEqual(['Home A', 'Home B']);
    expect(groups[1]?.description).toBe(
      'settingsMachines.count · server.signedOut',
    );
  });
});

describe('the machine list column in the rail door', () => {
  beforeEach(() => {
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    desktopState.value = false;
    poolFeatureState.value = 'disabled';
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
    ]);
  });

  it('keeps machine rows and All machines inside the rail door, and sends configuration to Settings', async () => {
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    const navigatedTo = () =>
      [...routerPushSpy.mock.calls, ...routerReplaceSpy.mock.calls].map(
        (call) => call[0],
      );

    const row = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.row.srv-a.machine-a1',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(navigatedTo()).toContain('/machines/machine-a1?serverId=srv-a');

    const all = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.rail.all',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(all);
    });
    expect(navigatedTo()).toContain('/machines');

    // Machine defaults are configuration: they have one home, the Settings door, and are pushed there.
    const defaults = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.defaults',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(defaults);
    });
    expect(routerPushSpy.mock.calls.at(-1)?.[0]).toMatch(
      /^\/settings\/machines\/defaults/,
    );
  });

  it('opens with All machines and Defaults, then the machines under Your machines (lab m-defaults, R)', async () => {
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    const order = [
      'settings.machines.rail.all',
      'settings.machines.defaults',
      'settings.machines.row.srv-a.machine-a1',
    ];
    const seen: string[] = [];
    tree
      .findAll((node) => order.includes(node.props?.testID))
      .forEach((node) => {
        if (!seen.includes(node.props.testID)) seen.push(node.props.testID);
      });
    expect(seen).toEqual(order);
    expect(
      tree.findAll(
        (node) => node.props?.title === 'machines.destinations.yours',
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps a long fleet's offline machines under one fold after the ones that can work", async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    setMachines([
      {
        serverId: 'srv-a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline],
      },
    ]);
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    const visible = (testID: string) =>
      tree.findAll((node) => node.props?.testID === testID).length > 0;

    expect(visible('settings.machines.row.srv-a.machine-a1')).toBe(true);
    const fold = tree.findAll(
      (node) =>
        typeof node.props?.testID === 'string' &&
        node.props.testID.startsWith('settings.machines.offline.') &&
        node.props.detail !== undefined,
    )[0];
    expect(fold?.props.detail).toBe('9');
    expect(visible('settings.machines.row.srv-a.old-0')).toBe(false);

    await act(async () => {
      await pressTestInstanceAsync(fold!);
    });
    expect(visible('settings.machines.row.srv-a.old-0')).toBe(true);
  });
});

describe('the presets group in the rail', () => {
  const withPresets = (state: { value: unknown[] | null; loading: boolean }) => {
    setMachines([{ serverId: 'srv-a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local')] }]);
    viewModelState.value = {
      ...viewModelState.value,
      presetsByServerId: state.value ? { 'srv-a': state.value } : {},
      presetInventory: { statesByServerId: { 'srv-a': { ...state, error: null } }, refresh: vi.fn() },
    } as typeof viewModelState.value;
  };
  const sectionIds = (tree: Awaited<ReturnType<typeof renderScreen>>['tree']) => tree.findAll((node) => typeof node.props?.testID === 'string'
    && node.props.testID.startsWith('settings.machines.presets.')).map((node) => node.props.testID as string);

  it('keeps its group and its add control while the list is read again, and only waits for the first answer', async () => {
    const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
    withPresets({ value: [], loading: true });
    const rereading = sectionIds((await renderScreen(React.createElement(MachinesColumn))).tree);
    expect(rereading).toContain('settings.machines.presets.new.srv-a');

    withPresets({ value: null, loading: true });
    const first = sectionIds((await renderScreen(React.createElement(MachinesColumn))).tree);
    expect(first).not.toContain('settings.machines.presets.new.srv-a');
  });
});

describe('MachinesRelayDriftBanner', () => {
  beforeEach(() => {
    desktopState.value = false;
    relayDriftState.value = {
      title: 'Drift',
      description: 'This computer serves another Home.',
    };
  });

  it('says so on the web, where it cannot repair, and offers the repair in the desktop app', async () => {
    const web = (
      await renderScreen(React.createElement(MachinesRelayDriftBanner))
    ).tree;
    expect(
      web.findAll(
        (node) =>
          node.props?.testID === 'settings.machines.relayDrift.webNotice',
      ),
    ).not.toHaveLength(0);
    expect(web.findAllByType('RelayDriftActionCard' as never)).toHaveLength(0);

    desktopState.value = true;
    const desktop = (
      await renderScreen(React.createElement(MachinesRelayDriftBanner))
    ).tree;
    expect(desktop.findAllByType('RelayDriftActionCard' as never)).toHaveLength(
      1,
    );
  });
});
