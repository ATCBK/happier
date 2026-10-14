import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterRuntime } from '@/dev/testkit/runtime/routerRuntime';

// The router (route params and their setter) is the navigation boundary; the request hook and the chip stay real.
const router = vi.hoisted(() => ({
  runtime: null as null | ReturnType<typeof createExpoRouterRuntime>,
}));
vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
  useLocalSearchParams: () => router.runtime!.module.useLocalSearchParams(),
  useRouter: () => router.runtime!.module.useRouter(),
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

afterEach(() => {
  standardCleanup();
});

async function mountChip(params: Record<string, string>) {
  router.runtime = createExpoRouterRuntime({ params: () => params });
  const { useSessionCapabilitiesOpenRequest } = await import(
    './sessionCapabilitiesRoute'
  );
  const { createCapabilitiesActionChip } = await import(
    './createCapabilitiesActionChip'
  );
  const opened: string[] = [];
  let intents = 0;
  function Composer() {
    const route = useSessionCapabilitiesOpenRequest();
    const { consume } = route;
    const openRequest = React.useMemo(
      () => (route.requested ? { consume } : null),
      [route.requested, consume],
    );
    const chip = createCapabilitiesActionChip({
      label: '6 skills · 7 MCP',
      attention: false,
      stabilityKey: 'session:s1',
      popoverContent: () => null,
      onIntent: () => {
        intents += 1;
      },
      openRequest,
    });
    return chip.render!({
      chipStyle: () => ({}),
      iconColor: '#000',
      showLabel: true,
      textStyle: {},
      countTextStyle: {},
      chipAnchorRef: React.createRef(),
      toggleCollapsedPopover: (key: string) => opened.push(key),
    } as never) as React.ReactElement;
  }
  await renderScreen(<Composer />);
  return { opened, intents: () => intents, runtime: router.runtime };
}

it('opens "This session gets" once for ?capabilities=open and clears the param', async () => {
  const { opened, intents, runtime } = await mountChip({
    id: 's1',
    capabilities: 'open',
  });
  await act(async () => {});
  // Clearing the param re-renders the chip with no request: it opened exactly once.
  expect(runtime.state.params.capabilities).toBeUndefined();
  expect(opened).toEqual(['session-capabilities']);
  // The route entry demands the preview like a press does, or the sheet would wait on "Checking…" forever.
  expect(intents()).toBe(1);
});

it('leaves the sheet closed without the param', async () => {
  const { opened } = await mountChip({ id: 's1' });
  expect(opened).toEqual([]);
});
