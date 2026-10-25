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

const scope = { serverId: 'home', accountId: 'alice' };
const markdown =
  '# Runbook\n\n😀 A replay shows **one** row. 😀 A replay shows **one** row.\n\nEscalate to on-call.';
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
    renderedText?: string;
    selection: { start: number; end: number };
  }) => void;
}>;

describe('ArtifactPassageSelection on iOS/Android', () => {
  it('captures the second repeated native selection through rendered UTF-16 offsets, including emoji and inline syntax', async () => {
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
      .find((run) => String(run.props.markdown).startsWith('😀 A replay'))!;
    const comment = (
      paragraph.props.contextMenuItems as readonly ContextMenuItem[]
    )[0]!;
    // Native adds a real leading spacing newline. The event carries that actual text;
    // neither the selected quote nor its offsets may be searched in the Markdown.
    const renderedText = '\n😀 A replay shows one row. 😀 A replay shows one row.\n';
    const selectedText = 'A replay shows one row.';
    const selectedStart = renderedText.lastIndexOf(selectedText);
    await act(async () =>
      comment.onPress({
        text: selectedText,
        renderedText,
        selection: { start: selectedStart, end: selectedStart + selectedText.length },
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
    const start = markdown.lastIndexOf('A replay');
    const end = markdown.indexOf('\n\nEscalate');
    expect(document?.passage?.value).toMatchObject({
      ref: { kind: 'doc', artifactId: 'runbook', serverId: 'home' },
      revision,
      range: { start, end },
      quote: markdown.slice(start, end),
    });
  });

  it('does not publish a whole-block comment from an older native binary without actual rendered text', async () => {
    home = await activateStorageAccountScope(scope);
    const screen = await renderScreen(<ArtifactPassageSelection artifactId="runbook" markdown={markdown} revision={revision} />);
    const paragraph = screen.findAllByType('EnrichedMarkdownText').find(run => String(run.props.markdown).startsWith('😀 A replay'))!;
    const comment = (paragraph.props.contextMenuItems as readonly ContextMenuItem[])[0]!;
    await act(async () => comment.onPress({ text: 'A replay', selection: { start: 4, end: 12 } }));
    expect(navigation.push).not.toHaveBeenCalled();
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
    // Inactive ranges pass pointers to their descendants; only the marked block is focusable.
    expect(triggers.filter((node) => node.props.focusable === true)).toHaveLength(1);
    await act(async () =>
      triggers.find((node) => node.props.focusable === true)!.props.onPress(),
    );
    expect(opened).toEqual(['thread-1']);
  });

  it('requests exact re-comment selection from a marked block and rejects a completion after its reviewed revision changes', async () => {
    home = await activateStorageAccountScope(scope);
    const start = markdown.indexOf('A replay');
    const requested: ArtifactNativeSelectionRequest[] = [];
    const props = { artifactId: 'runbook', markdown, revision, onRequestNativeSelection: (request: ArtifactNativeSelectionRequest) => requested.push(request),
      margin: { passages: [{ id: 'thread-1', location: { state: 'exact' as const, range: { start, end: start + 8 } } }],
        focusedId: null, onFocus: () => {}, onOpen: () => {}, renderCard: () => null } };
    const screen = await renderScreen(<ArtifactPassageSelection {...props} />);
    const trigger = screen.findAllByType('Pressable').find(node => node.props.onLongPress)!;
    expect(trigger).toBeDefined();
    await act(async () => trigger.props.onLongPress());
    expect(requested).toHaveLength(1);
    expect(requested[0]!.markdown).toBe(markdown.slice(markdown.indexOf('😀'), markdown.indexOf('\n\nEscalate')));
    expect(navigation.push).not.toHaveBeenCalled();
    const renderedText = '\n😀 A replay shows one row. 😀 A replay shows one row.\n';
    const text = 'A replay shows one row.';
    const selection = { renderedText, text, start: renderedText.lastIndexOf(text), end: renderedText.lastIndexOf(text) + text.length };
    await act(async () => screen.update(<ArtifactPassageSelection {...props} revision={{ ...revision, bodyVersion: 8 }} />));
    expect(requested[0]!.complete(selection)).toBe(false);
    expect(navigation.push).not.toHaveBeenCalled();
    const current = screen.findAllByType('Pressable').find(node => node.props.onLongPress)!;
    await act(async () => current.props.onLongPress());
    await act(async () => expect(requested[1]!.complete(selection)).toBe(true));
    expect(navigation.push).toHaveBeenCalledTimes(1);
    await act(async () => screen.unmount());
    expect(requested[1]!.complete(selection)).toBe(false);
  });

  it('opens the existing thread list instead of choosing the first thread when a tapped block contains multiple passages', async () => {
    home = await activateStorageAccountScope(scope);
    const opened: string[] = [];
    const list = vi.fn();
    const first = markdown.indexOf('A replay');
    const second = markdown.lastIndexOf('A replay');
    const screen = await renderScreen(<ArtifactPassageSelection artifactId="runbook" markdown={markdown} revision={revision}
      margin={{ passages: [first, second].map((start, index) => ({ id: `thread-${index}`, location: { state: 'exact', range: { start, end: start + 8 } } })),
        focusedId: null, onFocus: () => {}, onOpen: id => opened.push(id), onOpenThreadList: list, renderCard: () => null }} />);
    const trigger = screen.findAllByType('Pressable').find(node => String(node.props.testID ?? '').startsWith('markdown-source-range-trigger') && node.props.focusable === true)!;
    await act(async () => trigger.props.onPress());
    expect(opened).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('retains the Doc reference definitions for a marked selection host and maps its repeated label into the full source', async () => {
    home = await activateStorageAccountScope(scope);
    const source = '# Earlier\n\n[shown][ref] and [shown][ref].\n\n[ref]: https://example.test';
    const start = source.indexOf('shown');
    const requests: ArtifactNativeSelectionRequest[] = [];
    const screen = await renderScreen(<ArtifactPassageSelection artifactId="references" markdown={source} revision={revision}
      onRequestNativeSelection={request => requests.push(request)} margin={{ passages: [{ id: 'reference-thread',
        location: { state: 'exact', range: { start, end: start + 5 } } }], focusedId: null, onFocus: () => {}, onOpen: () => {}, renderCard: () => null }} />);
    await act(async () => screen.findAllByType('Pressable').find(node => node.props.onLongPress)!.props.onLongPress());
    expect(requests[0]!.markdown).toContain('[ref]: https://example.test');
    const renderedText = '\nshown and shown.\n';
    const selected = renderedText.lastIndexOf('shown');
    await act(async () => expect(requests[0]!.complete({ renderedText, text: 'shown', start: selected, end: selected + 5 })).toBe(true));
    const href = String(navigation.push.mock.calls[0]![0]);
    const draftId = new URL(href, 'https://app.test').searchParams.get('draftId')!;
    expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion', draftId })?.document).toMatchObject({ passage: { value: {
      range: { start: source.lastIndexOf('[shown]') + 1, end: source.lastIndexOf('[shown]') + 6 }, quote: 'shown',
    } } });
  });

  it('shows the changed passage\'s own card above the body and, while it waits for new text, offers Attach here instead of Comment', async () => {
    home = await activateStorageAccountScope(scope);
    const complete = vi.fn();
    const { View } = await import('react-native');
    const props = { artifactId: 'runbook', markdown, revision,
      margin: { passages: [{ id: 'moved', location: { state: 'detached' as const } }], focusedId: null, onFocus: () => {}, onOpen: () => {},
        renderCard: (id: string) => <View testID={`card:${id}`} /> } };
    const screen = await renderScreen(<ArtifactPassageSelection {...props}
      margin={{ ...props.margin, attach: { discussionId: 'moved', complete } }} />);
    expect(screen.findAllHostsByTestId('card:moved')).toHaveLength(1);
    const paragraph = screen.findAllByType('EnrichedMarkdownText').find(run => String(run.props.markdown).startsWith('😀 A replay'))!;
    const action = (paragraph.props.contextMenuItems as readonly ContextMenuItem[])[0]!;
    expect(action.text).toContain('attachHere');
    const renderedText = '\n😀 A replay shows one row. 😀 A replay shows one row.\n';
    const text = 'A replay shows one row.';
    const start = renderedText.lastIndexOf(text);
    await act(async () => action.onPress({ text, renderedText, selection: { start, end: start + text.length } }));
    expect(navigation.push).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    const begin = markdown.lastIndexOf('A replay');
    expect(complete.mock.calls[0]![0]).toMatchObject({ revision, range: { start: begin, end: markdown.indexOf('\n\nEscalate') } });
  });
});
