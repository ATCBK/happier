import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { buildWidgetSurfaceArtifactIdV1, WidgetSurfaceReadV1Schema } from '@happier-dev/protocol/widgets';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { selectMachinesPresetMachine } from './machinesWidgetPresets';

import { useMachinesWidgetAreaBinding } from './useMachinesWidgetAreaBinding';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
  'widgets.group.inputs.set': ['ui'], 'widgets.area.layout.reset': ['ui'],
} });
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: policy } }, version: 0 });
  return artifacts.handle(path, init);
} });
let disposeActionLoader: (() => void) | undefined;
beforeAll(async () => {
  const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
  disposeActionLoader = await installRealActionExecutorModuleLoader();
});
afterAll(() => disposeActionLoader?.());
beforeEach(() => {
  artifacts.clear();
  storage.setState({ settingsScope: { serverId: runtime.serverId, accountId: 'account-a' },
    settings: { ...storage.getState().settings, actionsSettingsV1: policy } });
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);

afterEach(() => {
  standardCleanup();
});

const names = { overview: 'Overview', machineHealth: 'Machine health' };
type Binding = ReturnType<typeof useMachinesWidgetAreaBinding>;

type Pinned = Readonly<{ serverId: string; machineId: string }> | null;
let setPinned: (next: Pinned) => void = () => {};

function Probe(props: Readonly<{ onBinding: (binding: Binding) => void }>) {
    const [pinned, set] = React.useState<Pinned>(null);
    setPinned = set;
    const binding = useMachinesWidgetAreaBinding({ serverId: 'home', names, pinnedMachine: pinned });
    props.onBinding(binding);
    return null;
}

function pinnedMachineOf(binding: Binding | null): unknown {
  const group = binding?.presets[0]?.items.find(
    (item) => item.kind === 'group',
  );
  return group?.kind === 'group' ? group.context?.machine : undefined;
}

describe('the All machines dashboard area (plan 60 AGW-19, D5)', () => {
  it.each(['reporting', 'first'] as const)('waits for fleet presence before pinning the %s fallback, then Reset materializes the online machine', async (branch) => {
    const offline = { serverId: runtime.serverId, machineId: 'NLDW6-3-11-20' };
    const online = { serverId: runtime.serverId, machineId: 'NLDW4-5-40-40' };
    const initial = {
      serverId: runtime.serverId, needsYou: [], thisComputerMachineId: null,
      reportingMachineKeys: branch === 'reporting' ? [JSON.stringify([offline.serverId, offline.machineId])] : [],
      fleet: { firstOnline: null as Pinned, first: offline, onlineKeys: [] as string[] }, presenceLoaded: false,
    };
    const hook = await renderHook((selection: typeof initial) => {
      const candidate = selectMachinesPresetMachine(selection);
      return useMachinesWidgetAreaBinding({ serverId: runtime.serverId, names, pinnedMachine: candidate });
    }, { initialProps: initial });
    expect(pinnedMachineOf(hook.getCurrent())).toBeUndefined();
    // Publications arrive independently of the full presence census and cannot settle the pin.
    await hook.rerender({ ...initial,
      reportingMachineKeys: [...initial.reportingMachineKeys, JSON.stringify([online.serverId, online.machineId])] });
    expect(pinnedMachineOf(hook.getCurrent())).toBeUndefined();
    await hook.rerender({ ...initial, presenceLoaded: true,
      fleet: { firstOnline: online, first: offline, onlineKeys: [JSON.stringify([online.serverId, online.machineId])] } });
    expect(pinnedMachineOf(hook.getCurrent())).toEqual({ kind: 'value', value: online });
    // Reproduce the previous QA customization through the real platform writer before Reset.
    await act(async () => { expect(await hook.getCurrent().port!.execute({
      actionId: 'widgets.group.inputs.set', instanceId: 'overview:group:0',
      bindings: { machine: { kind: 'value', value: offline } },
    })).toMatchObject({ ok: true }); });
    const body = artifacts.readPlainBody(buildWidgetSurfaceArtifactIdV1(hook.getCurrent().surface!));
    expect(body).not.toBeNull();
    expect(JSON.parse(body!)).toMatchObject({ items: [{ context: { machine: { value: offline } } }, {}] });
    await act(async () => { expect(await hook.getCurrent().resetPreset()).toMatchObject({ ok: true }); });
    const read = await hook.getCurrent().port!.execute({ actionId: 'widgets.item.list' });
    if (!read.ok) throw new Error(read.errorCode);
    expect(WidgetSurfaceReadV1Schema.parse(read.result)).toMatchObject({ items: [
      { kind: 'group', context: { machine: { kind: 'value', value: online } } },
      { kind: 'widget' },
    ] });
    // Once the loaded fleet supplied a pin, later attention changes do not reshuffle the static preset.
    await hook.rerender({ ...initial, presenceLoaded: true });
    expect(pinnedMachineOf(hook.getCurrent())).toEqual({ kind: 'value', value: online });
    await hook.unmount();
  });

  it('pins the preset’s machine the first time the page offers one, and never moves it while the person looks', async () => {
    let latest: Binding | null = null;
    const onBinding = (binding: Binding) => {
      latest = binding;
    };
    await renderScreen(<Probe onBinding={onBinding} />);
    expect(pinnedMachineOf(latest)).toBeUndefined();

    await act(async () => {
      setPinned({ serverId: 'home', machineId: 'edge-1' });
    });
    expect(pinnedMachineOf(latest)).toEqual({
      kind: 'value',
      value: { serverId: 'home', machineId: 'edge-1' },
    });
    const presets = latest!.presets;

    // edge-1 recovers and nl2 now needs the person: the default layout does not reshuffle under them.
    await act(async () => {
      setPinned({ serverId: 'home', machineId: 'nl2' });
    });
    expect(pinnedMachineOf(latest)).toEqual({
      kind: 'value',
      value: { serverId: 'home', machineId: 'edge-1' },
    });
    expect(latest!.presets).toBe(presets);

    await act(async () => { setPinned(null); });
    expect(pinnedMachineOf(latest)).toEqual({
      kind: 'value', value: { serverId: 'home', machineId: 'edge-1' },
    });
    expect(latest!.presets).toBe(presets);
  });
});
