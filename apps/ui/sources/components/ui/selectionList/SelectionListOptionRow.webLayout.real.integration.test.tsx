// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import {
  ListPresentationProvider,
  type ListPresentation,
} from '@/components/ui/lists/listPresentation';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const native = await import('react-native');
  const mock = createReanimatedModuleMock();
  const Animated = {
    ...mock.default,
    View: native.View,
    ScrollView: native.ScrollView,
    Text: native.Text,
  };
  return { ...mock, ...Animated, default: Animated };
});

installWebLayoutBridge();
const { PlanOptionRow } = await import('./SelectionListOptionRow');
const { SelectionListSelectedMarkContext } =
  await import('./SelectionListOptionPresentationContext');

const ROW_WIDTH = 416;

/** A machine row's facts: memory, CLI glyphs, a star. Together they are wider than half a two-column row. */
function TrailingFacts() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View testID="fact-memory" style={{ width: 92, height: 16 }} />
      <View testID="fact-glyphs" style={{ width: 76, height: 16 }} />
      <View testID="fact-star" style={{ width: 28, height: 28 }} />
    </View>
  );
}

it.each<ListPresentation>(['page', 'grouped'])(
  "keeps a selected row's check and every trailing fact inside a row narrower than twice their width (%s)",
  async (presentation) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <ListPresentationProvider value={presentation}>
            <SelectionListSelectedMarkContext.Provider value="check">
              <View testID="frame" style={{ width: ROW_WIDTH }}>
                <PlanOptionRow
                  option={{
                    id: 'machine',
                    label: 'Loading…',
                    subtitle: 'Online',
                    rightAccessory: <TrailingFacts />,
                  }}
                  rootTestID="list"
                  stepId="root"
                  isSelected
                  isFocused={false}
                  onSelect={() => {}}
                  onPushStep={() => {}}
                />
              </View>
            </SelectionListSelectedMarkContext.Provider>
          </ListPresentationProvider>,
        ),
      );
      const layout = await measureWebLayout(host, {
        viewport: { width: 600, height: 400 },
      });
      const frame = layout.rect('frame');
      const check = layout.rect('list:root:option-selected-mark:machine');
      const star = layout.rect('fact-star');
      expect(check.right).toBeLessThanOrEqual(frame.right);
      expect(star.right).toBeLessThanOrEqual(check.left);
      expect(layout.rect('fact-memory').left).toBeGreaterThanOrEqual(
        frame.left,
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
