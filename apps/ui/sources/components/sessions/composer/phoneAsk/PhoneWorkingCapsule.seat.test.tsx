/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

const { StyleSheet, View } = await import('react-native');
const { PhoneWorkingCapsuleView } = await import('./PhoneWorkingCapsule');
const { PageBottomBarSeatProvider } =
  await import('@/components/ui/layout/useFloatingChromeClearance');
const { SessionCockpitBottomChromeHeightContext } =
  await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const { EditorAccessoryBar } =
  await import('@/components/ui/code/editor/chrome/EditorAccessoryBar');
const { ReviewBar } =
  await import('@/components/workspaces/scm/review/hunkReview/ReviewBar');

const TAB_BAR = 84;

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function capsuleBottom(screen: Screen): number {
  let dock = screen.findByTestId('phone-ask-working-capsule')?.parent ?? null;
  while (dock && StyleSheet.flatten(dock.props.style)?.position !== 'absolute')
    dock = dock.parent;
  return StyleSheet.flatten(dock?.props.style).bottom as number;
}

async function layout(screen: Screen, testID: string, height: number) {
  const host = screen.findHostByTestId(testID);
  await act(async () => {
    host?.props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
    });
  });
}

/** One phone File page under the cockpit's floating tab bar, with the working capsule over it. */
function Page(props: Readonly<{ children: React.ReactNode }>) {
  return (
    <SessionCockpitBottomChromeHeightContext.Provider value={TAB_BAR}>
      <PageBottomBarSeatProvider>
        <View style={{ flex: 1 }}>{props.children}</View>
        <PhoneWorkingCapsuleView
          kind="working"
          agent="Codex"
          onView={() => {}}
        />
      </PageBottomBarSeatProvider>
    </SessionCockpitBottomChromeHeightContext.Provider>
  );
}

describe('the phone working capsule takes the seat above the page bottom bar', () => {
  it('rides above the Edit key row, which cannot step aside (Save and the keys stay reachable)', async () => {
    const screen = await renderScreen(
      <Page>
        <EditorAccessoryBar testID="key-row" trailing={<View />}>
          <View />
        </EditorAccessoryBar>
      </Page>,
    );
    // The key row pads by the tab bar, so its box reaches from the page bottom to its top edge.
    await layout(screen, 'key-row', TAB_BAR + 50);
    expect(capsuleBottom(screen)).toBeGreaterThan(TAB_BAR + 50);
    await screen.unmount();
  });

  it('rides above the Changes review bar, and returns to the tab bar once the bar leaves', async () => {
    const screen = await renderScreen(
      <Page>
        <ReviewBar
          testID="file-review-bar"
          current={1}
          total={3}
          onKeep={() => {}}
          onDiscard={() => {}}
        />
      </Page>,
    );
    await layout(screen, 'file-review-bar', 60);
    expect(capsuleBottom(screen)).toBeGreaterThan(TAB_BAR + 60);
    await screen.update(<Page>{null}</Page>);
    expect(capsuleBottom(screen)).toBe(TAB_BAR);
    await screen.unmount();
  });
});
