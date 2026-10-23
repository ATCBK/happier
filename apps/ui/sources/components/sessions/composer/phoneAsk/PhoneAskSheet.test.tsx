import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock(
    { platformOS: 'ios' },
    { useWindowDimensions: () => ({ width: 390, height: 844 }) },
  );
});

const { View } = await import('react-native');
const { PhoneAskSheet } = await import('./PhoneAskSheet');
const { PhoneAskSheetProvider, usePhoneAskSheetState, usePhoneAskSheet } =
  await import('./phoneAskSheetState');
const { useAskSessionReveal } =
  await import('@/components/ui/code/selection/useAskSessionReveal');
type SessionComposerModel =
  import('@/components/sessions/composer/sessionComposerModel').SessionComposerModel;

type Harness = Readonly<{ reveal: () => void; phase: () => string | null }>;

const contentNodes = new Set<object>();
/** The composer's rendered content: one node identity for as long as it stays mounted. */
function ComposerContent() {
  const identity = React.useRef({}).current;
  React.useEffect(() => {
    contentNodes.add(identity);
  }, [identity]);
  return <View testID="session-composer-content" />;
}

function composerModel(
  sending: boolean,
  focus: () => void,
): SessionComposerModel {
  return {
    content: <ComposerContent />,
    ref: { kind: 'session', sessionId: 's1' },
    address: { serverId: 'srv', sessionId: 's1' },
    sending,
    focus,
  };
}

/** The File page's Ask (reveal) and the Session screen's composer slot under one phone cockpit state. */
function Cockpit(
  props: Readonly<{
    sending: boolean;
    focus: () => void;
    harness: { current: Harness | null };
  }>,
) {
  const state = usePhoneAskSheetState(true);
  return (
    <PhoneAskSheetProvider value={state}>
      <FilePageAsk harness={props.harness} />
      <PhoneAskSheet composer={composerModel(props.sending, props.focus)} />
    </PhoneAskSheetProvider>
  );
}

function FilePageAsk(
  props: Readonly<{ harness: { current: Harness | null } }>,
) {
  const reveal = useAskSessionReveal();
  const sheet = usePhoneAskSheet();
  props.harness.current = { reveal, phase: () => sheet?.phase ?? null };
  return null;
}

describe('PhoneAskSheet', () => {
  it('turns the one Session composer slot into the Ask sheet in place, collapses on Send, and never remounts it', async () => {
    contentNodes.clear();
    const focus = vi.fn();
    const harness: { current: Harness | null } = { current: null };
    const screen = await renderScreen(
      <Cockpit sending={false} focus={focus} harness={harness} />,
    );
    const contentCount = () =>
      screen.tree.findAllByProps({ testID: 'session-composer-content' }).length;
    const sheetCount = () =>
      screen.tree.findAllByProps({ testID: 'phone-ask-sheet.slot' }).length;

    // Closed: the composer stays in the Session screen's ordinary slot.
    expect(sheetCount()).toBe(0);
    expect(contentCount()).toBe(1);

    // Ask from the File page: the same content becomes the sheet, with its grabber, and takes the caret.
    await act(async () => {
      harness.current!.reveal();
    });
    expect(harness.current!.phase()).toBe('open');
    expect(sheetCount()).toBeGreaterThan(0);
    expect(contentCount()).toBe(1);
    expect(
      screen.tree
        .findAllByProps({ testID: 'phone-ask-sheet.slot' })[0]!
        .findAllByProps({ testID: 'session-composer-content' }),
    ).toHaveLength(1);
    expect(
      screen.tree.findAllByProps({ testID: 'phone-ask-sheet.grabber' }).length,
    ).toBeGreaterThan(0);
    expect(focus).toHaveBeenCalledTimes(1);

    // The composer's own Send starts: the sheet gives way to the working capsule's phase.
    await screen.update(<Cockpit sending focus={focus} harness={harness} />);
    expect(harness.current!.phase()).toBe('working');
    expect(sheetCount()).toBe(0);
    expect(contentCount()).toBe(1);
    expect(contentNodes.size).toBe(1);
    await screen.unmount();
  });

  it('returns the composer to the screen when the sheet is dismissed without sending', async () => {
    const harness: { current: Harness | null } = { current: null };
    let close: (() => void) | null = null;
    function CloseProbe() {
      close = usePhoneAskSheet()?.close ?? null;
      return null;
    }
    function Host() {
      const state = usePhoneAskSheetState(true);
      return (
        <PhoneAskSheetProvider value={state}>
          <FilePageAsk harness={harness} />
          <CloseProbe />
          <PhoneAskSheet composer={composerModel(false, () => {})} />
        </PhoneAskSheetProvider>
      );
    }
    const screen = await renderScreen(<Host />);
    await act(async () => {
      harness.current!.reveal();
    });
    expect(
      screen.tree.findAllByProps({ testID: 'phone-ask-sheet.slot' }).length,
    ).toBeGreaterThan(0);
    await act(async () => {
      close!();
    });
    expect(harness.current!.phase()).toBe('closed');
    expect(
      screen.tree.findAllByProps({ testID: 'phone-ask-sheet.slot' }),
    ).toHaveLength(0);
    expect(
      screen.tree.findAllByProps({ testID: 'session-composer-content' }),
    ).toHaveLength(1);
    await screen.unmount();
  });
});

describe('PhoneWorkingCapsuleView', () => {
  it('floats above the floating tab bar when one covers the page, so the capsule stays in view', async () => {
    const { PhoneWorkingCapsuleView } = await import('./PhoneWorkingCapsule');
    const { SessionCockpitBottomChromeHeightContext } = await import(
      '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
    );
    const { StyleSheet } = await import('react-native');
    const tabBarHeight = 84;
    const screen = await renderScreen(
      <SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
        <PhoneWorkingCapsuleView kind="working" agent="Codex" onView={() => {}} />
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    const capsule = screen.findByTestId('phone-ask-working-capsule');
    expect(capsule).toBeTruthy();
    let dock = capsule!.parent;
    while (dock && StyleSheet.flatten(dock.props.style)?.position !== 'absolute') dock = dock.parent;
    expect(StyleSheet.flatten(dock?.props.style)).toMatchObject({ position: 'absolute' });
    expect(StyleSheet.flatten(dock?.props.style).bottom).toBeGreaterThanOrEqual(tabBarHeight);
    await screen.unmount();
  });
});
