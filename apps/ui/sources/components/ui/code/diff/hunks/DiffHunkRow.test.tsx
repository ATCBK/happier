// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { DiffHunkInfo, DiffViewerHunks } from '../diffViewerTypes';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

// Two change runs inside one git hunk: they are reviewed as two changes.
const PATCH =
  '--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n first\n-before\n+after\n middle\n-old\n+new\n last\n';
const initialState = storage.getState();

describe('DiffHunkRow on the shared hunk contract', () => {
  let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
  beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
    storage.setState({
      settings: {
        ...storage.getState().settings,
        filesDiffRendererMode: 'happier',
      },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
    browser.restore();
  });

  async function render(hunks: DiffViewerHunks) {
    const { DiffViewer } = await import('../DiffViewer.web');
    return renderScreen(
      <DiffViewer
        mode="unified"
        virtualized={false}
        filePath="a.ts"
        unifiedDiff={PATCH}
        hunks={hunks}
      />,
    );
  }

  it('draws one row per change run, keeps state per row and hands the pressed change to its action', async () => {
    const keep = vi.fn<(hunk: DiffHunkInfo) => void>();
    const discard = vi.fn<(hunk: DiffHunkInfo) => void>();
    const screen = await render({
      currentIndex: 1,
      numberOffset: 2,
      numberTotal: 7,
      stateOf: (hunk) => (hunk.index === 0 ? 'kept' : 'open'),
      actions: { keep, discard },
      disabledReason: (_hunk, action) =>
        action === 'discard' ? 'Discard needs devbox' : null,
    });
    expect(screen.findByTestId('diff-hunk-row-0')).toBeTruthy();
    expect(screen.findByTestId('diff-hunk-row-1')).toBeTruthy();
    const text = screen.getTextContent();
    expect(text).toContain('hunkReview.kept');
    expect(text).toContain('Discard needs devbox');
    // The current change is "change 4 of 7" across the comparison and announces it.
    const keepButton = screen.findByTestId('diff-hunk-keep-1')!;
    expect(String(keepButton.props.accessibilityLabel)).toContain(
      'hunkReview.keepA11y',
    );
    await act(async () => {
      keepButton.props.onPress();
    });
    expect(keep).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, rangeStart: 4, rangeEnd: 4 }),
    );
    expect(screen.findByTestId('diff-hunk-discard-1')!.props.disabled).toBe(
      true,
    );
    // A kept change offers no Discard and lets go of its tint.
    expect(screen.findByTestId('diff-hunk-discard-0')).toBeFalsy();
  });

  it('says why Discard is unavailable on any change whose buttons are showing, not only the current one', async () => {
    const screen = await render({
      currentIndex: 1,
      actions: { keep: vi.fn(), discard: vi.fn() },
      disabledReason: (_hunk, action) =>
        action === 'discard' ? 'Untracked file' : null,
    });
    const count = () => screen.getTextContent().split('Untracked file').length - 1;
    // Quiet rows stay quiet: only the current change speaks.
    expect(count()).toBe(1);
    const row = screen.findByTestId('diff-hunk-row-0')!;
    await act(async () => {
      row.props.onMouseEnter?.();
    });
    // Hovering a change reveals its buttons and, with the disabled Discard, the reason beside it.
    expect(count()).toBe(2);
    expect(screen.findByTestId('diff-hunk-discard-0')!.props.disabled).toBe(true);
    await act(async () => {
      screen.findByTestId('diff-hunk-row-0')!.props.onMouseLeave?.();
    });
    expect(count()).toBe(1);
  });

  it('leaves notes-only callers without rows', async () => {
    const screen = await render({
      renderNote: (hunk) => <>{`note-${hunk.index}`}</>,
    });
    expect(screen.findByTestId('diff-hunk-row-0')).toBeFalsy();
    expect(screen.getTextContent()).toContain('note-0');
  });
});
