import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { renderScreen } from '@/dev/testkit';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});

const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } =
  await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { ArtifactPassageSelection } = await import('./ArtifactPassageSelection');

const scope = { serverId: 'home', accountId: 'alice' };
const markdown =
  '# Runbook\n\nA replay shows one row. A replay shows **one** row.\n\nEscalate to on-call.';
const revision = { headerVersion: 2, bodyVersion: 7 };
let home: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

afterEach(() => {
  home?.dispose();
  home = null;
  resetSessionDraftRepositoryForTests();
  navigation.push.mockClear();
});

type ContextMenuItem = Readonly<{
  text: string;
  onPress: (event: {
    text: string;
    selection: { start: number; end: number };
  }) => void;
}>;

describe('ArtifactPassageSelection on iOS/Android', () => {
  it('starts a comment on the block chosen from the selection menu, captured at its source range and revision', async () => {
    home = await activateStorageAccountScope(scope);
    const screen = await renderScreen(
      <ArtifactPassageSelection
        artifactId="runbook"
        markdown={markdown}
        revision={revision}
      />,
    );
    const paragraph = screen
      .findAllByType('EnrichedMarkdownText')
      .find((run) => String(run.props.markdown).startsWith('A replay'))!;
    const comment = (
      paragraph.props.contextMenuItems as readonly ContextMenuItem[]
    )[0]!;
    // The selected phrase repeats in the block; its drawn offsets are never searched for.
    await act(async () =>
      comment.onPress({
        text: 'A replay shows',
        selection: { start: 24, end: 38 },
      }),
    );
    expect(navigation.push).toHaveBeenCalledTimes(1);
    const href = String(navigation.push.mock.calls[0]![0]);
    const draftId = new URL(href, 'https://app.test').searchParams.get(
      'draftId',
    );
    expect(draftId).not.toBeNull();
    const document = getSessionDraftSnapshot(scope, {
      kind: 'newDiscussion',
      draftId: draftId!,
    })?.document as
      | {
          passage?: {
            value?: {
              range: unknown;
              revision: unknown;
              quote: string;
              ref: unknown;
            };
          };
        }
      | undefined;
    const start = markdown.indexOf('A replay');
    const end = markdown.indexOf('\n\nEscalate');
    expect(document?.passage?.value).toMatchObject({
      ref: { kind: 'doc', artifactId: 'runbook', serverId: 'home' },
      revision,
      range: { start, end },
      quote: markdown.slice(start, end),
    });
  });

  it('marks a commented passage and opens its thread from its block, not from blocks without one', async () => {
    home = await activateStorageAccountScope(scope);
    const start = markdown.indexOf('Escalate');
    const opened: string[] = [];
    const screen = await renderScreen(
      <ArtifactPassageSelection
        artifactId="runbook"
        markdown={markdown}
        revision={revision}
        margin={{
          passages: [
            {
              id: 'thread-1',
              location: { state: 'exact', range: { start, end: start + 8 } },
            },
          ],
          focusedId: null,
          onFocus: () => undefined,
          onOpen: (id) => {
            opened.push(id);
          },
          renderCard: () => null,
        }}
      />,
    );
    expect(
      screen
        .findAllHostsByTestId('passage-mark')
        .map((node) => node.children.join('')),
    ).toEqual(['Escalate']);
    const triggers = screen
      .findAllByType('Pressable')
      .filter((node) =>
        String(node.props.testID ?? '').startsWith(
          'markdown-source-range-trigger',
        ),
      );
    expect(triggers.filter((node) => !node.props.disabled)).toHaveLength(1);
    await act(async () =>
      triggers.find((node) => !node.props.disabled)!.props.onPress(),
    );
    expect(opened).toEqual(['thread-1']);
  });
});
