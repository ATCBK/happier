import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { DiffHunkRowRegistryContext } from '@/components/ui/code/diff/hunks/diffHunkReadingLine';
import type { FileChangesDiffSurface } from './FileChangesRegions';
import type { FileChangesReview } from './useFileChangesReview';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  const dimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  return createReactNativeNativeMock(
    { platformOS: 'ios' },
    {
      useWindowDimensions: () => dimensions,
      Dimensions: { get: () => dimensions },
    },
  );
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
// The device class is a platform adapter boundary; these cases are a phone.
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => 'phone' as const };
});

import { FileChangesBody } from './FileChangesRegions';

const scope = { serverId: 's1', machineId: 'm1', rootPath: '/repo' };
const noop = () => {};

/** A ready review of a file with two text changes, not live and not captured (so no bytes are fetched). */
function readyReview(): FileChangesReview {
  const units = [{ key: 'u1' }, { key: 'u2' }];
  const review = {
    changesScope: { kind: 'workingTree' },
    scopeKind: 'workingTree',
    scopeTabs: [],
    selectScope: noop,
    turnNumber: null,
    status: 'ready',
    error: null,
    unifiedDiff:
      'diff --git a/logo.svg b/logo.svg\n@@ -1 +1 @@\n-<svg/>\n+<svg width="2"/>\n',
    capturedFile: null,
    comparison: null,
    live: false,
    controller: {
      strip: {
        current: 1,
        total: 2,
        fileComplete: false,
        nextFile: null,
        filesLeft: 0,
        canKeepAll: true,
      },
      previous: noop,
      next: noop,
      keepCurrentAndAdvance: noop,
      discardCurrent: noop,
      nextFile: noop,
      followReadingLine: noop,
      // The arrival default: the first change (the viewer has reported its rows).
      revealHunk: { key: 'u1' },
      currentHunk: null,
      reviewUnits: units,
    },
    hunks: { stateOf: () => 'pending' },
    reviewUnits: units,
    scrollToLineId: 'line-2',
    keyboard: { next: noop, previous: noop },
    discardDisabledReason: null,
  };
  return review as unknown as FileChangesReview;
}

function RegistryProbe() {
  const registry = React.useContext(DiffHunkRowRegistryContext);
  return React.createElement('RegistryProbe', {
    testID: 'registry-probe',
    provided: registry !== null,
  });
}

/** Rendered host nodes with this testID (a composite passes its testID down, so it would count twice). */
function hostsWith(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.tree.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
}

async function renderBody(filePath: string) {
  const surfaces: FileChangesDiffSurface[] = [];
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={null}>
      <FileChangesBody
        review={readyReview()}
        keyboardActive={false}
        image={{ scope, filePath }}
      >
        {(surface) => {
          surfaces.push(surface);
          // The page's diff draws its leading content inside its own scroller, above the first line.
          return <>{surface.leadingContent}<RegistryProbe /></>;
        }}
      </FileChangesBody>
    </InjectedAuthProvider>,
  );
  return { screen, surfaces };
}

describe('FileChangesBody on a phone (P5 RV1)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('an SVG change shows the image compare and its text changes in the one common text region', async () => {
    const { screen, surfaces } = await renderBody('assets/logo.svg');
    try {
      expect(
        hostsWith(screen, 'file-changes-image-compare'),
      ).toHaveLength(1);
      // The text changes get the same review bar, reading-line registry and scroll tracking as a text file.
      expect(
        hostsWith(screen, 'file-review-bar'),
      ).toHaveLength(1);
      expect(
        screen.tree.findByProps({ testID: 'registry-probe' }).props.provided,
      ).toBe(true);
      expect(surfaces.at(-1)?.onScroll).toEqual(expect.any(Function));
      // One page scroll: the image compare leads the diff inside the diff's scroller, not above it.
      expect(surfaces.at(-1)?.leadingContent).toBeTruthy();
      // It opens at the compare: the first change's arrival reveal waits until the review moves.
      expect(surfaces.at(-1)?.scrollToLineId).toBeUndefined();
    } finally {
      await screen.unmount();
    }
  });

  it('a bitmap image change stays image-only', async () => {
    const { screen, surfaces } = await renderBody('assets/hero.png');
    try {
      expect(
        hostsWith(screen, 'file-changes-image-compare'),
      ).toHaveLength(1);
      expect(
        hostsWith(screen, 'file-review-bar'),
      ).toHaveLength(0);
      expect(surfaces).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
