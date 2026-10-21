/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  readPresentationNotice,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import type { HunkReviewChangeActions } from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';
import { t } from '@/text';
import { ChangeMarkerPeek } from './ChangeMarkerPeek';
import {
  buildEditorChangeMarkers,
  type EditorChangeRevertResult,
} from './editorChangeMarkers';
import type { EditorChangeMarkersController } from './useEditorChangeMarkers';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
afterEach(() => {
  retirePresentationNotice();
  standardCleanup();
});

const marker = buildEditorChangeMarkers(
  'a.ts',
  null,
  '@@ -1 +1 @@\n-old\n+new\n',
)[0]!;
const controller: EditorChangeMarkersController = {
  selected: marker,
  close: () => {},
  next: () => {},
  previous: () => {},
  onDocumentChange: () => {},
  revertInDraft: async () => ({ ok: false, reason: 'moved_on' }),
};

function actionsWith(
  discard: () => Promise<EditorChangeRevertResult>,
  keep = vi.fn(),
): HunkReviewChangeActions<EditorChangeRevertResult> {
  return {
    state: 'open',
    keep,
    copy: () => {},
    ask: () => {},
    discard,
    disabledReason: () => null,
  };
}


describe('ChangeMarkerPeek removed lines', () => {
  it('numbers each removed row with its line in the old file (ED3 E1)', async () => {
    const replaced = buildEditorChangeMarkers(
      'a.ts',
      null,
      '@@ -20,2 +20 @@\n-const key = route.path;\n-\tconst width = 0;\n+const key = useKey(route);\n',
    )[0]!;
    const screen = await renderScreen(
      <ChangeMarkerPeek marker={replaced} controller={{ ...controller, selected: replaced }} dirty={false} />,
    );
    type Node = { children: ReadonlyArray<Node | string> };
    const textOf = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join(' ');
    const rows = screen.findAllHostsByTestId('change-marker-peek-removed-row');
    expect(rows.map((row) => textOf(row as unknown as Node).replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/^20\s*−\s*const key = route\.path;$/),
      expect.stringMatching(/^21\s*−\s*const width = 0;$/),
    ]);
    // The old line keeps its indentation, so it sits where the code did (a single-line row must not collapse it).
    expect(textOf(rows[1] as unknown as Node)).toContain('\u00a0\u00a0const width = 0;');
  });
});

describe('ChangeMarkerPeek review actions', () => {
  it('draws the change verbs and refuses a draft Discard over lines the person edited, in place', async () => {
    const keep = vi.fn();
    const actions = actionsWith(
      async () => ({ ok: false, reason: 'moved_on' }),
      keep,
    );
    const screen = await renderScreen(
      <ChangeMarkerPeek
        marker={marker}
        controller={controller}
        dirty
        resolveChangeActions={() => actions}
      />,
    );
    for (const id of [
      'change-marker-peek-keep',
      'change-marker-peek-discard',
      'change-marker-peek-ask',
      'change-marker-peek-copy',
    ])
      expect(screen.findByTestId(id)).toBeTruthy();
    await act(async () => {
      screen.findByTestId('change-marker-peek-discard')!.props.onPress?.({});
    });
    expect(screen.getTextContent()).toContain(t('files.editing.youEditedThisChange'));
    expect(
      screen.findByTestId('change-marker-peek-discard')!.props
        .accessibilityState?.disabled ??
        screen.findByTestId('change-marker-peek-discard')!.props.disabled,
    ).toBe(true);
    await act(async () => {
      screen.findByTestId('change-marker-peek-keep')!.props.onPress?.({});
    });
    expect(keep).toHaveBeenCalledTimes(1);
    expect(readPresentationNotice()).toBeNull();
  });

  it('says the refusal on the page when the peek closed while Discard was checking', async () => {
    const result = createDeferred<EditorChangeRevertResult>();
    const actions = actionsWith(() => result.promise);
    const screen = await renderScreen(
      <ChangeMarkerPeek
        marker={marker}
        controller={controller}
        dirty
        resolveChangeActions={() => actions}
      />,
    );
    await act(async () => {
      screen.findByTestId('change-marker-peek-discard')!.props.onPress?.({});
    });
    await act(async () => {
      screen.unmount();
    });
    await act(async () => {
      result.resolve({ ok: false, reason: 'moved_on' });
      await result.promise;
    });
    expect(readPresentationNotice()?.message).toBe(t('files.editing.youEditedThisChange'));
  });
});
