import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The window size and the router are platform boundaries; the Inbox model and store stay real.
const routerMock = vi.hoisted(() => ({
  width: 390,
  current: null as null | {
    spies: { replace: { mock: { calls: unknown[][] }; mockClear: () => void } };
  },
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: routerMock.width,
      height: 844,
      scale: 1,
      fontScale: 1,
    }),
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('expo-router', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock();
  routerMock.current = mock;
  return mock.module;
});
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/track/tracking', () => ({ tracking: null }));

const initialState = storage.getState();

describe('InboxView focused item on a phone', () => {
  beforeEach(() => {
    routerMock.width = 390;
    routerMock.current?.spies.replace.mockClear();
    storage.setState(initialState, true);
    storage.setState({
      isDataReady: true,
      artifacts: {},
      profileScope: {
        serverId: getActiveServerSnapshot().serverId,
        accountId: 'account-a',
      },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
  });

  it('opens a linked item on its own page, as a phone row does, instead of stopping at the list', async () => {
    const { InboxView } = await import('./InboxView');
    await renderScreen(
      <InboxView
        focusedItem={{ kind: 'approval', serverId: 'home-1', id: 'approval-1' }}
      />,
    );

    expect(
      routerMock.current?.spies.replace.mock.calls.map(([href]) => href),
    ).toContain('/inbox/approvals/approval-1?serverId=home-1');
  });

  it('leaves the phone Inbox on its list when nothing is linked', async () => {
    const { InboxView } = await import('./InboxView');
    await renderScreen(<InboxView />);

    expect(routerMock.current?.spies.replace.mock.calls).toHaveLength(0);
  });

  it('restores the Inbox rail width when a wide page opens an item', async () => {
    routerMock.width = 1200;
    storage.getState().applyLocalSettings({ collectionRailWidthsV1: { inbox: 430 } });
    const { InboxView } = await import('./InboxView');
    const screen = await renderScreen(<InboxView focusedItem={{ kind: 'approval', serverId: 'home-1', id: 'approval-1' }} />);
    const layout = screen.findHostByTestId('inbox.layout');
    expect(layout).not.toBeNull();
    await act(async () => layout!.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } }));
    const style = [screen.findHostByTestId('inbox.list-pane')?.props.style].flat(Infinity)
      .filter(Boolean).reduce((result, part) => ({ ...result, ...part }), {});
    expect(style.width).toBe(430);
  });
});
