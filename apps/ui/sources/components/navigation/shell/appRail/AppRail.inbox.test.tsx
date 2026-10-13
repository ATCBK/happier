import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    styleSheet: { hairlineWidth: 1 },
  }),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
    { maxHeight: 600, maxWidth: 400, placement: 'bottom' }),
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => standardCleanup());

function entries() {
  return buildAppRailEntries(
    resolveCompactAppDestinations({
      builtins: {
        externalSessions: true,
        inbox: true,
        workflows: true,
        friends: true,
      },
      pages: [],
    }),
  );
}

function renderRail(activeId: string | null, onOpen: (entry: unknown) => void) {
  return renderScreen(
    <InjectedAuthProvider credentials={null}>
      <InboxSummaryProvider>
        <AppRailSurface
          entries={entries()}
          activeId={activeId}
          onOpen={onOpen}
          renderFooter={(item) => <View testID={item.id} />}
        />
      </InboxSummaryProvider>
    </InjectedAuthProvider>,
  );
}

describe('AppRail Inbox (lab inbox-I2)', () => {
  it('opens the Inbox popover beside the rail instead of leaving the page', async () => {
    const onOpen = vi.fn();
    const screen = await renderRail(null, onOpen);
    expect(screen.findByTestId('inbox.popover.open')).toBeNull();

    await screen.pressByTestIdAsync('app-rail:inbox');

    expect(screen.findByTestId('inbox.popover.open')).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('inbox.popover.open');
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'inbox' }));
    expect(screen.findByTestId('inbox.popover.open')).toBeNull();
  });

  it('opens the Inbox page itself while the Inbox is already on screen', async () => {
    const onOpen = vi.fn();
    const screen = await renderRail('inbox', onOpen);

    await screen.pressByTestIdAsync('app-rail:inbox');

    expect(screen.findByTestId('inbox.popover.open')).toBeNull();
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inbox' }),
    );
  });
});
