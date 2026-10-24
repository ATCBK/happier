// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { DiffHunkInfo, DiffViewerHunks } from '../diffViewerTypes';

// The window size is the platform boundary that makes this a phone.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The popover's portal and window measurement are the boundary; the real menu renders inline beneath it.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const PATCH =
  '--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n first\n-before\n+after\n middle\n-old\n+new\n last\n';
const initialState = storage.getState();

describe('DiffHunkRow on a phone', () => {
  let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
  beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
    storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'happier' } });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
    browser.restore();
  });

  it('is a quiet label whose long press opens the change menu with the same keyed actions', async () => {
    const keep = vi.fn<(hunk: DiffHunkInfo) => void>();
    const discard = vi.fn<(hunk: DiffHunkInfo) => void>();
    const comment = vi.fn();
    const hunks: DiffViewerHunks = {
      currentIndex: 0,
      stateOf: () => 'open',
      actions: { keep, discard, ask: vi.fn(), copy: vi.fn() },
      disabledReason: (_hunk, action) => (action === 'discard' ? 'Discard needs devbox' : null),
    };
    const { DiffViewer } = await import('../DiffViewer.web');
    const screen = await renderScreen(
      <DiffViewer mode="unified" virtualized={false} filePath="a.ts" unifiedDiff={PATCH} hunks={hunks}
        onPressAddComment={comment} />,
    );
    // No buttons on the row; the bar and the menu carry the actions.
    expect(screen.findByTestId('diff-hunk-keep-1')).toBeFalsy();
    await act(async () => { screen.findByTestId('diff-hunk-row-press-1')!.props.onLongPress(); });
    for (const id of ['keep', 'discard', 'comment', 'ask', 'copy']) expect(screen.findByTestId(`hunk-menu-${id}-1`)).toBeTruthy();
    expect(screen.getTextContent()).toContain('Discard needs devbox');
    await screen.pressByTestIdAsync('hunk-menu-keep-1');
    // The menu runs the action on the frame after it closes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(keep).toHaveBeenCalledWith(expect.objectContaining({ index: 1, rangeStart: 4 }));
    expect(screen.findByTestId('hunk-menu-keep-1')).toBeFalsy();
    await act(async () => { screen.findByTestId('diff-hunk-row-press-1')!.props.onLongPress(); });
    await screen.pressByTestIdAsync('hunk-menu-comment-1');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    // Comment lands on the change's first changed line.
    expect(comment).toHaveBeenCalledWith(expect.objectContaining({ kind: 'remove', oldLine: 4 }));
    await screen.update(
      <DiffViewer mode="unified" virtualized={false} filePath="a.ts" unifiedDiff={PATCH}
        hunks={{ ...hunks, actions: { keep, ask: vi.fn(), copy: vi.fn() } }} onPressAddComment={comment} />,
    );
    await act(async () => { screen.findByTestId('diff-hunk-row-press-1')!.props.onLongPress(); });
    expect(screen.findByTestId('hunk-menu-discard-1')).toBeFalsy();
    for (const id of ['keep', 'comment', 'ask', 'copy']) expect(screen.findByTestId(`hunk-menu-${id}-1`)).toBeTruthy();
  });
});
