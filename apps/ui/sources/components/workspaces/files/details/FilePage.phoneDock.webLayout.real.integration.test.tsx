// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { FilePageToolbar } from '../file/FilePageHeader';
import { FileViewerFindSurface } from './FileViewerFindSurface';

/**
 * A phone's File page lives under the cockpit's floating dock. What the page puts at the bottom edge (its
 * toolbar, and the seated Find bar) has to be reachable: a pointer at a control's centre must land on the
 * control, not on the dock drawn over it (the 390×844 occlusion found in QA r254).
 */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// The native animation boundary keeps real RNW layout boxes during browser measurement.
vi.mock('react-native-reanimated', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/reanimated')
  ).createReanimatedModuleMock();
  const native =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return {
    ...mock,
    default: {
      ...mock.default,
      View: native.View,
      Text: native.Text,
      ScrollView: native.ScrollView,
    },
  };
});

installWebLayoutBridge();

const DOCK_HEIGHT = 64;
const VIEWPORT = { width: 390, height: 844 } as const;
const seed: FileFindSeed = {
  query: 'needle',
  options: { matchCase: false, regex: false },
  target: {
    kind: 'file',
    path: 'a.ts',
    anchor: { kind: 'fileLine', startLine: 1 },
  },
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

/** The page, then the dock painted over the screen's bottom edge, as the cockpit's portal does. */
function PhoneScreen(props: Readonly<{ children: React.ReactNode }>) {
  return (
    <KeyboardShortcutProvider handlers={{}}>
      <PluginSurfaceFocusEligibilityProvider active>
        <SessionCockpitBottomChromeHeightContext.Provider value={DOCK_HEIGHT}>
          <View style={{ width: VIEWPORT.width, height: VIEWPORT.height }}>
            <View style={{ flex: 1, minHeight: 0 }}>{props.children}</View>
            <View
              testID="dock"
              pointerEvents="auto"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: DOCK_HEIGHT,
                zIndex: 100,
              }}
            />
          </View>
        </SessionCockpitBottomChromeHeightContext.Provider>
      </PluginSurfaceFocusEligibilityProvider>
    </KeyboardShortcutProvider>
  );
}

async function measure(page: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<PhoneScreen>{page}</PhoneScreen>));
  return measureWebLayout(host, {
    viewport: VIEWPORT,
    settle: (replay) => act(replay),
  });
}

describe('a phone File page under the cockpit dock', () => {
  it('lets a pointer reach the toolbar controls', async () => {
    const layout = await measure(
      <FilePageToolbar
        modes={[]}
        displayMode="file"
        onDisplayMode={() => {}}
        find={{ onOpen: () => {} }}
        edit={{ kind: 'edit', onPress: () => {} }}
        bottomInset={0}
      />,
    );
    const find = layout.rect('file-page-toolbar-find');
    expect(find.width).toBeGreaterThan(0);
    expect(find.receivesPointer).toBe(true);
    expect(layout.rect('file-page-toolbar-edit').receivesPointer).toBe(true);
    expect(find.bottom).toBeLessThanOrEqual(layout.rect('dock').top);
  });

  it('lets a pointer reach the open Find bar input and Done', async () => {
    const layout = await measure(
      <FileViewerFindSurface
        surfaceId="file:dock"
        active
        findSeed={seed}
        content={{ path: 'a.ts', mode: 'file', text: 'needle\nneedle again' }}
      >
        {() => <View testID="file-body" style={{ flex: 1 }} />}
      </FileViewerFindSurface>,
    );
    const input = layout.rect('file-viewer-find.input');
    expect(input.width).toBeGreaterThan(0);
    expect(input.receivesPointer).toBe(true);
    expect(layout.rect('file-viewer-find.close').receivesPointer).toBe(true);
    expect(layout.rect('file-viewer-find').bottom).toBeLessThanOrEqual(
      layout.rect('dock').top,
    );
  });
});
