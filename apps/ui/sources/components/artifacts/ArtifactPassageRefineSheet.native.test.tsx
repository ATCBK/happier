import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { renderScreen } from '@/dev/testkit';
import type { ArtifactNativeSelectionRequest } from './ArtifactPassageSelection';

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
const { ArtifactPassageRefineContent } =
  await import('./ArtifactPassageRefineSheet');

const scope = { serverId: 'home', accountId: 'alice' };
const markdown =
  '# Runbook\n\n😀 A replay shows **one** row. 😀 A replay shows **one** row.\n\nEscalate to on-call.';
const revision = { headerVersion: 2, bodyVersion: 7 };
const renderedText =
  '\n😀 A replay shows one row. 😀 A replay shows one row.\n';
const selectedText = 'A replay shows one row.';
const selectedStart = renderedText.lastIndexOf(selectedText);
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
    renderedText?: string;
    selection: { start: number; end: number };
  }) => void;
}>;

/** A marked Doc block's Comment, requested by the real Doc body owner. */
async function requestFromMarkedBlock() {
  const requests: ArtifactNativeSelectionRequest[] = [];
  const start = markdown.indexOf('A replay');
  const props = {
    artifactId: 'runbook',
    markdown,
    revision,
    onRequestNativeSelection: (request: ArtifactNativeSelectionRequest) =>
      requests.push(request),
    margin: {
      passages: [
        {
          id: 'thread-1',
          location: {
            state: 'exact' as const,
            range: { start, end: start + 8 },
          },
        },
      ],
      focusedId: null,
      onFocus: () => {},
      onOpen: () => {},
      renderCard: () => null,
    },
  };
  const doc = await renderScreen(<ArtifactPassageSelection {...props} />);
  await act(async () =>
    doc
      .findAllByType('Pressable')
      .find((node) => node.props.onLongPress)!
      .props.onLongPress(),
  );
  expect(requests).toHaveLength(1);
  return { doc, props, request: requests[0]! };
}

function hostComment(
  host: Awaited<ReturnType<typeof renderScreen>>,
): ContextMenuItem {
  const run = host
    .findAllByType('EnrichedMarkdownText')
    .find((node) => String(node.props.markdown).startsWith('😀 A replay'))!;
  return (run.props.contextMenuItems as readonly ContextMenuItem[])[0]!;
}

describe('ArtifactPassageRefineContent on iOS/Android', () => {
  it('lets a marked block be re-commented on the exact words chosen in the same native Markdown menu', async () => {
    home = await activateStorageAccountScope(scope);
    const { request } = await requestFromMarkedBlock();
    const onClose = vi.fn();
    const host = await renderScreen(
      <ArtifactPassageRefineContent request={request} onClose={onClose} />,
    );
    await act(async () =>
      hostComment(host).onPress({
        text: selectedText,
        renderedText,
        selection: {
          start: selectedStart,
          end: selectedStart + selectedText.length,
        },
      }),
    );
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    const draftId = new URL(
      String(navigation.push.mock.calls[0]![0]),
      'https://app.test',
    ).searchParams.get('draftId')!;
    expect(
      getSessionDraftSnapshot(scope, { kind: 'newDiscussion', draftId })
        ?.document,
    ).toMatchObject({
      passage: {
        value: {
          range: {
            start: markdown.lastIndexOf('A replay'),
            end: markdown.lastIndexOf('row.') + 4,
          },
        },
      },
    });
  });

  it('stays open and says the selection could not be placed when the Doc moved on, and never comments on the whole block', async () => {
    home = await activateStorageAccountScope(scope);
    const { doc, props, request } = await requestFromMarkedBlock();
    await act(async () =>
      doc.update(
        <ArtifactPassageSelection
          {...props}
          revision={{ ...revision, bodyVersion: 8 }}
        />,
      ),
    );
    const onClose = vi.fn();
    const host = await renderScreen(
      <ArtifactPassageRefineContent request={request} onClose={onClose} />,
    );
    expect(host.findByTestId('artifact:passage-refine.failed')).toBeNull();
    await act(async () =>
      hostComment(host).onPress({
        text: selectedText,
        renderedText,
        selection: {
          start: selectedStart,
          end: selectedStart + selectedText.length,
        },
      }),
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.findByTestId('artifact:passage-refine.failed')).not.toBeNull();
  });

  it('treats a native menu without the drawn-text snapshot as a failed selection instead of a block fallback', async () => {
    home = await activateStorageAccountScope(scope);
    const { request } = await requestFromMarkedBlock();
    const onClose = vi.fn();
    const host = await renderScreen(
      <ArtifactPassageRefineContent request={request} onClose={onClose} />,
    );
    await act(async () =>
      hostComment(host).onPress({
        text: selectedText,
        selection: { start: 0, end: selectedText.length },
      }),
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.findByTestId('artifact:passage-refine.failed')).not.toBeNull();
  });
});
