import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { useMachinesWidgetAreaBinding } from './useMachinesWidgetAreaBinding';

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
