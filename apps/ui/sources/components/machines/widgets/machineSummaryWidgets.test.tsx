import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { getWidgetSizeFootprintV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const boundary = vi.hoisted(() => ({
  rpc: vi.fn<
    (input: {
      method: string;
      payload: unknown;
      signal?: AbortSignal;
    }) => Promise<unknown>
  >(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeAppStateEmitter, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // The app is in the foreground: mounted widgets may demand live values.
    return createReactNativeWebMock({ AppState: createReactNativeAppStateEmitter('active').appState });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
// The scoped machine RPC transport is the external boundary; the resource store, its demand and the strip stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: boundary.rpc }),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await import('@/sync/domains/machines/resources/machineRpc');
const { useMachineWidgetMachine } = await import('@/components/machines/widgets/machineWidgetKit');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineResourceStore } =
  await import('@/sync/domains/machines/resources/machineResourceStore');
const { WidgetFrameBodyMetaContext } = await import('@/components/widgets/frame/widgetFrameBodyCaption');
const { MachineVitalsWidget } = await import('./MachineVitalsWidget');
const { MachineAttentionStatedAbove } = await import('./machineAttentionStatedAbove');
const { MachineFleetWidget, orderFleetMachines, resolveFleetPresentation } =
  await import('./MachineFleetWidget');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { MachineMetricWidget, narrowToVolume, readMachineMetricWidgetConfig } =
  await import('./MachineMetricWidget');
const { MachineSummaryStrip } = await import('@/components/machines/summary/MachineSummaryStrip');
const { DiskTile } = await import('@/components/machines/vitals/DiskTile');

const HOME = 'srv_widget_summary';
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
  const serverId = await home.addHome({ name: 'Widget Home', serverUrl: 'https://machine-summary-widgets.test', serverIdentityId: HOME, accountId: 'owner' });
  home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
  accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://machine-summary-widgets.test', serverIdentityId: HOME,
    accountId: 'owner', request: home.request });
});
const resources = {
  v: 1,
  vitals: { state: 'reporting' },
  host: { logicalCores: 18, memoryTotalBytes: 128e9, bootedAt: 1 },
  attention: { level: 'calm', reasons: [] },
};
const sample = (sampledAt: number) => ({
  v: 1,
  sampledAt,
  intervalMs: 15_000,
  cpu: { reported: true, busyPct: 12 },
  memory: {
    reported: true,
    totalBytes: 128e9,
    availableBytes: 71e9,
    usedBytes: 57e9,
    pressure: { level: 'calm', source: 'psi' },
  },
  disk: { reported: true, volumes: [] },
  network: { reported: true, rxBps: 12, txBps: 3 },
});

afterEach(async () => {
  machineResourceStore.reset();
  boundary.rpc.mockReset();
  storage.setState({
    machines: {},
    machineListByServerId: {},
    machineListStatusByServerId: {},
  });
  standardCleanup();
  await accountConnection?.dispose();
  accountConnection = null;
  await home.reset();
});

function seed(machine: ReturnType<typeof createMachineFixture>) {
  storage.setState({
    machineListByServerId: { [HOME]: [machine] },
    machineListStatusByServerId: { [HOME]: 'idle' },
  });
}

/** The frame lends the body its header meta slot; here it is drawn beside the body so the test can read it. */
function MetaHost(props: Readonly<{ children: React.ReactNode }>) {
  const [meta, setMeta] = React.useState<React.ReactNode>(null);
  return (
    <WidgetFrameBodyMetaContext.Provider value={setMeta}>
      {meta}
      {props.children}
    </WidgetFrameBodyMetaContext.Provider>
  );
}

async function renderVitals(size: WidgetSizeV1) {
  return renderScreen(
    <MetaHost>
      <WidgetPresentationProvider
        value={{
          size,
          footprint: getWidgetSizeFootprintV1('home', size)!,
        }}
      >
        <MachineVitalsWidget
          input={{ machine: { serverId: HOME, machineId: 'm1' } }}
          serverId={HOME}
          testID="vitals"
        />
      </WidgetPresentationProvider>
    </MetaHost>,
  );
}

describe('Vitals widget (lab rw V, VS)', () => {
  it('is demand on the summary transport while mounted and draws the strip’s three rings', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonStateVersion: 1,
        daemonState: { resources },
      }),
    );
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: {
        cpu: [{ t: sampledAt, y: 12 }],
        memory: [{ t: sampledAt, y: 45 }],
        networkRx: [],
        networkTx: [],
      },
      attention: { level: 'calm', reasons: [] },
    });
    const screen = await renderVitals('small');
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    expect(
      boundary.rpc.mock.calls.some(
        ([call]) =>
          call.method.startsWith('machines.vitals') ||
          call.method.startsWith('daemon.vitals'),
      ),
    ).toBe(true);
    expect(screen.findByTestId('vitals.strip')).toBeTruthy();
    expect(screen.findByTestId('vitals.offline')).toBeNull();
  });

  it('says an offline machine with nothing read is offline, and asks it nothing', async () => {
    seed(
      createMachineFixture({
        id: 'm1',
        active: false,
        activeAt: Date.now() - 86_400_000,
        daemonState: { resources },
      }),
    );
    const screen = await renderVitals('medium');
    await act(async () => {
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    });
    expect(screen.findByTestId('vitals.offline')).toBeTruthy();
    expect(boundary.rpc).not.toHaveBeenCalled();
  });

  it('says a machine on an older Happier does not report, never zero', async () => {
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        daemonStateVersion: 1,
        daemonState: {},
      }),
    );
    const screen = await renderVitals('small');
    expect(screen.findByTestId('vitals.notReported')).toBeTruthy();
    expect(screen.findByTestId('vitals.strip')).toBeNull();
  });
});

describe('Machine widget names', () => {
  it('says the same disambiguated name as the Home list when two machines share a host name', async () => {
    const twin = (id: string) => createMachineFixture({ id, active: true, activeAt: Date.now(), daemonStateVersion: 1, daemonState: {} });
    storage.setState({
      machineListByServerId: { [HOME]: [twin('a1b2c3d4-0000'), twin('e5f6a7b8-0000')] },
      machineListStatusByServerId: { [HOME]: 'idle' },
    });
    const names: string[] = [];
    function Probe(props: Readonly<{ machineId: string }>) {
      names.push(useMachineWidgetMachine({ serverId: HOME, machineId: props.machineId }).name);
      return null;
    }
    const screen = await renderScreen(<><Probe machineId="a1b2c3d4-0000" /><Probe machineId="e5f6a7b8-0000" /></>);
    const [first, second] = names.slice(-2);
    expect(first).not.toEqual(second);
    await screen.unmount();
  });
});

describe('Vitals on an offline machine', () => {
  it('dates the values it still holds and makes no live claim about what the machine is doing', async () => {
    const sampledAt = Date.now();
    const machine = (online: boolean) => createMachineFixture({ id: 'm1', active: online, activeAt: online ? sampledAt : sampledAt - 3_600_000, daemonStateVersion: 1,
      daemonState: { resources: { ...resources, host: { logicalCores: 18, memoryTotalBytes: 128e9, bootedAt: 1 } } } });
    seed(machine(true));
    boundary.rpc.mockResolvedValue({ state: 'reporting', sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
    const screen = await renderVitals('medium');
    await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
    // Live: the sentence about what the machine is doing is there, and the header says nothing.
    expect(screen.getTextContent()).toContain('machineAttention.machine.idle');
    expect(screen.findByTestId('vitals.asOf')).toBeNull();
    // The machine drops offline while this app still holds its last reading.
    await act(async () => { seed(machine(false)); });
    await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
    expect(screen.findByTestId('vitals.memory')).toBeTruthy();
    expect(screen.findByTestId('vitals.offline')).toBeTruthy();
    expect(screen.findByTestId('vitals.asOf')).toBeTruthy();
    expect(screen.getTextContent()).not.toContain('machineAttention.machine.idle');
  });
});

describe('Vitals attention block', () => {
  const attentionResources = {
    ...resources,
    attention: { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: Date.now() - 60_000, metric: 'memory',
      nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true }] },
  };
  async function mountWithAttention(statedAbove: boolean) {
    const sampledAt = Date.now();
    seed(createMachineFixture({ id: 'm1', active: true, activeAt: sampledAt, daemonStateVersion: 1, daemonState: { resources: attentionResources } }));
    boundary.rpc.mockResolvedValue({ state: 'reporting', sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: attentionResources.attention });
    const entries = statedAbove
      ? [{ key: `${HOME}:m1`, serverId: HOME, machineId: 'm1', name: 'm1', online: true, attention: attentionResources.attention, lastAutomaticAction: null }]
      : [];
    const screen = await renderScreen(
      <MachineAttentionStatedAbove entries={entries as never}>
        <WidgetPresentationProvider value={{ size: 'medium', footprint: getWidgetSizeFootprintV1('home', 'medium')! }}>
          <MachineVitalsWidget input={{ machine: { serverId: HOME, machineId: 'm1' } }} serverId={HOME} testID="vitals" />
        </WidgetPresentationProvider>
      </MachineAttentionStatedAbove>,
    );
    await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
    return screen;
  }

  it('carries the full attention block and its one action on its own', async () => {
    const screen = await mountWithAttention(false);
    expect(screen.findByTestId('vitals.nextStep')).toBeTruthy();
  });

  it('steps back where the page above already names this machine: no repeated sentence, no second button', async () => {
    const screen = await mountWithAttention(true);
    expect(screen.findByTestId('vitals.nextStep')).toBeNull();
    expect(screen.findByTestId('vitals.phrase')).toBeTruthy();
    // The state itself stays on the ring row.
    expect(screen.findByTestId('vitals.memory')).toBeTruthy();
  });
});

describe('Machines widget presentation', () => {
    it('ends a failed cold read with recovery and retains machines when a refresh fails', async () => {
        const home = getActiveServerSnapshot().serverId;
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [home]: 'loading' } });
        const screen = await renderScreen(
            <WidgetPresentationProvider value={{ size: 'wide', footprint: getWidgetSizeFootprintV1('home', 'wide')! }}>
                <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
            </WidgetPresentationProvider>,
        );
        expect(screen.findByTestId('fleet.loading')).not.toBeNull();
        await act(async () => { storage.getState().markMachineListUnavailable(home); });
        expect(screen.findByTestId('fleet.loading')).toBeNull();
        expect(screen.findByTestId('fleet.error')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.noMachines');
        await act(async () => {
            storage.getState().applyMachines([createMachineFixture({ id: 'edge' }), createMachineFixture({ id: 'studio' })], true, { sourceServerId: home });
            storage.getState().markMachineListUnavailable(home);
        });
        expect(screen.findByTestId('fleet.error')).toBeNull();
        expect(screen.findByTestId('fleet.freshness')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.noMachines');
    });

    it('says it is still reading the Home\'s machines, never "no machines", until the machine list has arrived', async () => {
        const home = getActiveServerSnapshot().serverId;
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [home]: 'loading' } });
        const screen = await renderScreen(
            <WidgetPresentationProvider value={{ size: 'wide', footprint: getWidgetSizeFootprintV1('home', 'wide')! }}>
                <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
            </WidgetPresentationProvider>,
        );
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.noMachines');
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.addMachine');
        await act(async () => {
            storage.setState({ machineListByServerId: { [home]: [] }, machineListStatusByServerId: { [home]: 'idle' } });
        });
        // Once the list has really arrived empty, the empty state is the truth.
        expect(screen.getTextContent()).toContain('machines.widgets.body.fleet.noMachines');
    });

    it('opens a needs-you block in its row and folds it back in place when the machine recovers (lab FL, MO)', async () => {
        const home = getActiveServerSnapshot().serverId;
        const memory = { key: 'memory', level: 'needs_you', since: Date.now() - 60_000, metric: 'memory',
            nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true };
        // Fixture metadata carries only the name the rows show (`as never`: the boundary record's other fields are irrelevant here).
        const fleet = (edgeCalm: boolean) => [
            createMachineFixture({ id: 'zz-edge', active: true, activeAt: Date.now(), metadata: { host: 'zz-edge' } as never,
                daemonState: { resources: { ...resources, attention: edgeCalm ? { level: 'calm', reasons: [] } : { level: 'needs_you', reasons: [memory] } } } }),
            createMachineFixture({ id: 'nl2', active: true, activeAt: Date.now(), metadata: { host: 'nl2' } as never, daemonState: { resources } }),
        ];
        storage.setState({ machines: Object.fromEntries(fleet(false).map(machine => [machine.id, machine])),
            machineListByServerId: { [home]: fleet(false) }, machineListStatusByServerId: { [home]: 'idle' } });
        boundary.rpc.mockResolvedValue({ state: 'reporting', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        const screen = await renderScreen(
            <WidgetPresentationProvider value={{ size: 'medium', footprint: getWidgetSizeFootprintV1('home', 'medium')! }}>
                <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
            </WidgetPresentationProvider>,
        );
        expect(screen.findByTestId('fleet.machine.zz-edge.need')).toBeTruthy();
        expect(screen.findByTestId('fleet.machine.nl2.need')).toBeNull();
        // Needing the person puts zz-edge first; by name alone it would sort after nl2.
        const rowsBefore = screen.getTextContent().indexOf('zz-edge') < screen.getTextContent().indexOf('nl2');
        expect(rowsBefore).toBe(true);
        await act(async () => {
            storage.setState({ machines: Object.fromEntries(fleet(true).map(machine => [machine.id, machine])),
                machineListByServerId: { [home]: fleet(true) } });
        });
        await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
        // The block folds; the row stays where it was (worst-first order is held while the person looks).
        expect(screen.findByTestId('fleet.machine.zz-edge.need')).toBeNull();
        expect(screen.findByTestId('fleet.machine.zz-edge')).toBeTruthy();
        expect(screen.getTextContent().indexOf('zz-edge') < screen.getTextContent().indexOf('nl2')).toBe(rowsBefore);
    });

  it('keeps online machines first with this computer leading, offline last, so calm rows never reorder by state', () => {
    const entry = (id: string, online: boolean, thisComputer = false) => ({
      key: id,
      serverId: HOME,
      machine: createMachineFixture({ id }),
      name: id,
      online,
      thisComputer,
    });
    expect(
      orderFleetMachines([
        entry('studio', false),
        entry('nl2', true),
        entry('leeroy-mbp', true, true),
        entry('edge-1', true),
      ]).map((row) => row.name),
    ).toEqual(['leeroy-mbp', 'edge-1', 'nl2', 'studio']);
  });

  it('defaults to the device Machine summary setting and keeps the widget’s own choice when set (R8)', () => {
    const device = {
      style: 'sparklines' as const,
      metrics: ['cpu', 'memory', 'disk'] as const,
    };
    expect(resolveFleetPresentation({}, device)).toEqual(device);
    expect(
      resolveFleetPresentation(
        { style: 'rings', metrics: ['disk', 'cpu', 'bogus'] },
        device,
      ),
    ).toEqual({ style: 'rings', metrics: ['cpu', 'disk'] });
  });
});

describe('Metric widget configuration', () => {
  it('keeps a selected disk and custom warning across Small and Medium, and never substitutes another disk when it disappears', async () => {
    const sampledAt = Date.now();
    seed(createMachineFixture({ id: 'm1', activeAt: sampledAt, daemonState: { resources } }));
    const root = { id: 'root', label: 'Root', mount: '/', totalBytes: 100e9, availableBytes: 80e9 };
    const data = { id: 'data', label: 'Data', mount: '/data', totalBytes: 100e9, availableBytes: 20e9 };
    let volumes = [root, data];
    boundary.rpc.mockImplementation(async ({ method }) => {
      if (method === 'daemon.vitals.watch') return new Promise(() => {});
      if (method === 'machines.vitals.history.get') return { range: '1h', bucketMs: 60000, points: [], today: { rxBytes: 0, txBytes: 0 } };
      return { state: 'reporting', sample: { ...sample(sampledAt), disk: { reported: true, homeVolumeId: 'root', volumes } },
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } };
    });
    const draw = (size: WidgetSizeV1, warnAbove: number) => <MetaHost><WidgetPresentationProvider value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}>
      <MachineMetricWidget input={{ machine: { serverId: HOME, machineId: 'm1' }, metric: 'disk_free', volume: 'data', warnAbove }} serverId={HOME} testID="metric" />
    </WidgetPresentationProvider></MetaHost>;
    const screen = await renderScreen(draw('small', 75));
    const diskSummary = () => screen.root.findAll(node => node.type === Reflect.get(MachineSummaryStrip, 'type'))[0]?.props.availability?.summary?.disk;
    await act(async () => { await vi.waitFor(() => expect(diskSummary()).toMatchObject({ volumeId: 'data', availableBytes: 20e9, tone: 'warn' })); });
    expect(screen.getTextContent()).toContain('20 GB');
    await screen.update(draw('medium', 75));
    await act(async () => { await vi.waitFor(() => expect(screen.root.findAll(node => node.type === Reflect.get(DiskTile, 'type'))[0]?.props.sample.disk.volumes).toEqual([data])); });
    expect(screen.getTextContent()).toContain('20');
    await screen.update(draw('small', 85));
    await act(async () => { await vi.waitFor(() => expect(diskSummary()).toMatchObject({ volumeId: 'data', availableBytes: 20e9, tone: 'calm' })); });
    volumes = [root];
    await act(async () => machineResourceStore.retry({ serverId: HOME, machineId: 'm1', view: 'summary' }));
    await act(async () => { await vi.waitFor(() => expect(diskSummary()).toMatchObject({ volumeId: null, availableBytes: null })); });
    expect(screen.getTextContent()).not.toContain('80 GB');
    await screen.unmount();
  });
  it('reads the descriptor defaults (CPU, last hour) and the widget’s own choices', () => {
    expect(
      readMachineMetricWidgetConfig({
        machine: { serverId: HOME, machineId: 'm1' },
      }),
    ).toEqual({ metric: 'cpu', range: '1h', volume: null, warnAbove: null });
    expect(
      readMachineMetricWidgetConfig({
        metric: 'disk_free',
        range: '7d',
        volume: 'data',
        warnAbove: 85,
      }),
    ).toEqual({
      metric: 'disk_free',
      range: '7d',
      volume: 'data',
      warnAbove: 85,
    });
  });

  it('narrows the Overview’s disk tile to the chosen volume, and keeps an absent selection unmeasured', () => {
    const volume = (id: string) => ({
      id,
      label: id,
      mount: `/${id}`,
      totalBytes: 10,
      availableBytes: 5,
    });
    const base = {
      ...sample(1),
      disk: { reported: true, volumes: [volume('root'), volume('data')] },
    } as unknown as Parameters<typeof narrowToVolume>[0]; // A boundary-shaped sample; only the disk volumes matter here.
    expect(narrowToVolume(base, 'data').disk).toMatchObject({
      volumes: [{ id: 'data' }],
    });
    expect(narrowToVolume(base, 'missing').disk).toMatchObject({ volumes: [] });
  });
});
