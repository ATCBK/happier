import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';

import { usePaneActionRailRightPaneHiddenByDetails } from './PaneActionRailContext';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';

installAppPaneScopeHostCommonModuleMocks({
  getDimensions: () => ({ width: 1400, height: 900 }),
});

// Install boundary mocks before loading owners that capture storage imports.
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider, useAppPaneContext } =
  await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { useAppPaneScope } = await import('./hooks/useAppPaneScope');
const { useAppPaneActionRailVisible } =
  await import('./hooks/useAppPaneActionRailVisible');
const { toggleRightSidebarTab } =
  await import('@/components/appShell/rightSidebar/rightSidebarActions');

const scopeId = 'session:rail';
let pane: ReturnType<typeof useAppPaneScope>;
let mainMounts = 0;
let rightHiddenByDetails: ReturnType<
  typeof usePaneActionRailRightPaneHiddenByDetails
> = false;

function Rail() {
  rightHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
  return <View testID="rail-content" />;
}

function Main() {
  React.useEffect(() => {
    mainMounts += 1;
  }, []);
  return <View testID="main-content" />;
}

function HeaderRailProbe() {
  const visible = useAppPaneActionRailVisible(scopeId);
  return (
    <View
      testID={visible ? 'header-rail-visible' : 'header-rail-unavailable'}
    />
  );
}

function Harness() {
  const { registerDriver } = useAppPaneContext();
  pane = useAppPaneScope(scopeId);
  React.useEffect(
    () =>
      registerDriver({
        scopeId,
        rightSidebarAdapter: {
          renderActionRail: () => <Rail />,
          render: () => <View testID="right-content" />,
        },
        rightPaneBuiltinAdapter: {
          destinationIds: ['files'],
          defaultDestinationId: 'files',
          render: () => <View testID="right-content" />,
        },
        detailsPaneBuiltinAdapter: {
          destinationIds: ['details'],
          defaultDestinationId: 'details',
          render: () => <View testID="details-content" />,
        },
      }),
    [registerDriver],
  );
  return (
    <>
      <HeaderRailProbe />
      <AppPaneScopeHost scopeId={scopeId} main={<Main />} />
    </>
  );
}

describe('AppPaneScopeHost action rail', () => {
  it('keeps fallback header actions available before a rail driver registers', async () => {
    const screen = await renderScreen(
      <AppPaneProvider>
        <HeaderRailProbe />
      </AppPaneProvider>,
    );
    expect(screen.findByTestId('header-rail-unavailable')).not.toBeNull();
  });

  it.each([
    { width: 1400, hidden: false },
    { width: 640, hidden: true },
  ])(
    'reports whether opening the sidebar requires dismissing Review at $width px',
    async ({ width, hidden }) => {
      const screen = await renderScreen(
        <AppPaneProvider>
          <Harness />
        </AppPaneProvider>,
      );
      const host = screen.tree.root
        .findAllByType(View)
        .find((node) => typeof node.props.onLayout === 'function');
      const onLayout = host?.props.onLayout;
      if (!onLayout) throw new Error('Expected the pane host layout callback');
      await act(async () => {
        onLayout(createLayoutChangeEvent({ x: 0, y: 0, width, height: 900 }));
        pane.openDetailsTab({
          key: 'review',
          kind: 'scmReview',
          title: 'Review',
          resource: { kind: 'scmReview', scope: 'working' },
        });
      });
      expect(rightHiddenByDetails).toBe(hidden);
      await act(async () => {
        pane.openRight({ tabId: 'files' });
      });
      expect(rightHiddenByDetails).toBe(hidden);
    },
  );

  it('shows a side column folded by Details opened from main beside it instead of closing Details', async () => {
    const screen = await renderScreen(
      <AppPaneProvider>
        <Harness />
      </AppPaneProvider>,
    );
    const host = screen.tree.root
      .findAllByType(View)
      .find((node) => typeof node.props.onLayout === 'function');
    const onLayout = host?.props.onLayout;
    if (!onLayout) throw new Error('Expected the pane host layout callback');
    const press = () =>
      toggleRightSidebarTab(
        pane,
        'files',
        pane.scopeState?.right.activeTabId ?? null,
        (tabId) => pane.openRight({ tabId }),
        rightHiddenByDetails,
      );
    await act(async () => {
      onLayout(
        createLayoutChangeEvent({ x: 0, y: 0, width: 900, height: 900 }),
      );
      pane.openRight({ tabId: 'files' });
      pane.openDetailsTab(
        {
          key: 'file:a.ts',
          kind: 'file',
          title: 'a.ts',
          resource: { path: 'a.ts' },
        },
        { origin: 'main' },
      );
    });
    // Opened from the Project page: the side column folds to its rail, Details docks beside main.
    expect(screen.findByTestId('multi-pane-details-docked')).not.toBeNull();
    expect(screen.findByTestId('multi-pane-right-docked')).toBeNull();
    expect(rightHiddenByDetails).toBeTruthy();
    // The rail asks for the side column again (its tab is still the open one): it unfolds beside the
    // page, which becomes the drawer, rather than closing the page or closing the folded column.
    await act(async () => {
      press();
    });
    expect(pane.scopeState?.details.isOpen).toBe(true);
    expect(pane.scopeState?.right).toMatchObject({
      isOpen: true,
      activeTabId: 'files',
    });
    expect(screen.findByTestId('multi-pane-right-docked')).not.toBeNull();
    expect(screen.findByTestId('multi-pane-details-overlay')).not.toBeNull();
    expect(rightHiddenByDetails).toBe(false);
    // Once shown, the same tab closes the column again and the page docks back.
    await act(async () => {
      press();
    });
    expect(pane.scopeState?.right.isOpen).toBe(false);
    expect(pane.scopeState?.details.isOpen).toBe(true);
  });

  it('keeps navigation available with both panes closed and preserves the main tree through toggles', async () => {
    mainMounts = 0;
    const screen = await renderScreen(
      <AppPaneProvider>
        <Harness />
      </AppPaneProvider>,
    );
    expect(screen.findByTestId('rail-content')).not.toBeNull();
    expect(screen.findByTestId('header-rail-visible')).not.toBeNull();
    expect(pane.scopeState?.right.isOpen).toBe(false);
    expect(screen.findByTestId('right-content')).toBeNull();
    await act(async () => {
      pane.openRight({ tabId: 'files' });
    });
    expect(screen.findByTestId('right-content')).not.toBeNull();
    await act(async () => {
      pane.closeRight();
    });
    expect(screen.findByTestId('rail-content')).not.toBeNull();
    expect(mainMounts).toBe(1);
  });

  it('reserves the rail width before deciding whether both panes fit', async () => {
    const screen = await renderScreen(
      <AppPaneProvider>
        <Harness />
      </AppPaneProvider>,
    );
    await act(async () => {
      pane.openRight({ tabId: 'files' });
      pane.openDetailsTab({
        key: 'review',
        kind: 'scmReview',
        title: 'Review',
        resource: { kind: 'scmReview', scope: 'working' },
      });
    });
    const host = screen.tree.root
      .findAllByType(View)
      .find((node) => typeof node.props.onLayout === 'function');
    expect(host).toBeDefined();
    const onLayout = host?.props.onLayout;
    if (!onLayout) throw new Error('Expected the pane host layout callback');
    await act(async () => {
      onLayout(
        createLayoutChangeEvent({ x: 0, y: 0, width: 930, height: 900 }),
      );
    });
    expect(screen.findByTestId('multi-pane-details-docked')).toBeNull();
    expect(screen.findByTestId('multi-pane-details-overlay')).not.toBeNull();
    expect(screen.findByTestId('rail-content')).not.toBeNull();
  });
});
