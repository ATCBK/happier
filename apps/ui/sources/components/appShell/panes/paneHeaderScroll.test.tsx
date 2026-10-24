/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StyleSheet } from 'react-native';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

const { PaneHeader } = await import('./PaneHeader');
const { PaneHeaderScrollKey, PaneHeaderScrollScope, usePaneHeaderScrollSink } =
  await import('./paneHeaderScroll');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope } =
  await import('./paneHeaderSlot');

/** A primary scroller, reduced to its report: the physical distance its content has moved from the top. */
function Scroller(props: Readonly<{ distance: number }>) {
  const sink = usePaneHeaderScrollSink();
  React.useLayoutEffect(() => {
    sink?.reportTopDistance(props.distance);
  }, [props.distance, sink]);
  return null;
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function shade(screen: Screen): number | null {
  const node = screen.findHostByTestId('pane-header-shade');
  if (!node) return null;
  const opacity = StyleSheet.flatten(node.props.style)?.opacity as unknown;
  return typeof opacity === 'number'
    ? opacity
    : (opacity as { __getValue(): number }).__getValue();
}

describe('pane header shade channel', () => {
  it('follows the primary scroller: none at the top, half at 6 px, full from 12 px', async () => {
    const pane = (distance: number) => (
      <PaneHeaderScrollScope>
        <PaneHeader testID="header" title="Session" />
        <Scroller distance={distance} />
      </PaneHeaderScrollScope>
    );
    const screen = await renderScreen(pane(0));
    try {
      expect(shade(screen)).toBe(0);
      await screen.update(pane(6));
      expect(shade(screen)).toBeCloseTo(0.5);
      await screen.update(pane(40));
      expect(shade(screen)).toBe(1);
      await screen.update(pane(0));
      expect(shade(screen)).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it('gives each retained tab of a one-header pane its own channel: a hidden tab never moves the shown shade', async () => {
    const pane = (shown: 'files' | 'git', files: number, git: number) => (
      <PaneHeaderSlotProvider>
        <PaneHeaderScrollKey scrollKey={shown}>
          <PaneHeader testID="header" title={shown} />
        </PaneHeaderScrollKey>
        <PaneHeaderSlotScope slotKey="files">
          <Scroller distance={files} />
        </PaneHeaderSlotScope>
        <PaneHeaderSlotScope slotKey="git">
          <Scroller distance={git} />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>
    );
    const screen = await renderScreen(pane('files', 0, 0));
    try {
      expect(shade(screen)).toBe(0);
      // The hidden Git tab's list moves (restoration, a late layout): the Files header stays clear.
      await screen.update(pane('files', 0, 30));
      expect(shade(screen)).toBe(0);
      await screen.update(pane('files', 6, 30));
      expect(shade(screen)).toBeCloseTo(0.5);
      // Showing Git shows the shade its own retained offset left, and Files keeps its own for its return.
      await screen.update(pane('git', 6, 30));
      expect(shade(screen)).toBe(1);
      await screen.update(pane('files', 6, 30));
      expect(shade(screen)).toBeCloseTo(0.5);
    } finally {
      await screen.unmount();
    }
  });

  it('lets a pair without its own header report to the header around it', async () => {
    const peek = (passThrough: boolean, distance: number) => (
      <PaneHeaderScrollScope>
        <PaneHeader testID="header" title="Peek" />
        <PaneHeaderScrollScope passThrough={passThrough}>
          <Scroller distance={distance} />
        </PaneHeaderScrollScope>
      </PaneHeaderScrollScope>
    );
    const screen = await renderScreen(peek(true, 12));
    try {
      expect(shade(screen)).toBe(1);
    } finally {
      await screen.unmount();
    }
  });
});
