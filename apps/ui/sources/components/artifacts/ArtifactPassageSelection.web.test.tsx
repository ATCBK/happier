// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { View } from 'react-native';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

const { ArtifactPassageSelection } = await import('./ArtifactPassageSelection');
const markdown = 'Keep the original retry key across retries.';
let home: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
let body: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;

beforeEach(async () => {
  home = await activateStorageAccountScope({ serverId: 'home', accountId: 'alice' });
  body = document.createElement('div');
  body.textContent = markdown;
  document.body.append(body);
  let nextFrame = 0;
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  // jsdom supplies real DOM text/ranges/events, but no layout engine. Only
  // browser geometry is modeled; the production mapper and click listener run.
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 600, 30));
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
    return [new DOMRect(100 + this.startOffset * 8, 50, (this.endOffset - this.startOffset) * 8, 20)];
  } });
});

afterEach(() => {
  standardCleanup();
  document.getSelection()?.removeAllRanges();
  home?.dispose();
  home = null;
  body.remove();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountPassages(width: number, attach?: NonNullable<Parameters<typeof ArtifactPassageSelection>[0]['margin']>['attach']) {
  // `moved`: a passage that changed after its comment; it has no place in the body and is never marked.
  const onFocus = vi.fn();
  const onOpen = vi.fn();
  const onOpenThreadList = vi.fn();
  const screen = await renderScreen(<ArtifactPassageSelection artifactId="runbook" markdown={markdown}
    revision={{ headerVersion: 1, bodyVersion: 1 }} margin={{
      passages: [
        { id: 'paragraph', location: { state: 'exact', range: { start: 0, end: markdown.length } } },
        { id: 'quote', location: { state: 'exact', range: { start: 9, end: 26 } } },
        { id: 'moved', location: { state: 'detached' } },
      ],
      focusedId: null, onFocus, onOpen, onOpenThreadList, renderCard: id => <View testID={`card:${id}`} />, attach,
    }} />, { createNodeMock: () => body });
  await act(async () => {
    screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function')!.props.onLayout({
      nativeEvent: { layout: { width, height: 100, x: 0, y: 0 } },
    });
  });
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  expect(screen.findAllHostsByTestId('artifact:passage-mark:paragraph')).toHaveLength(1);
  expect(screen.findAllHostsByTestId('artifact:passage-mark:quote')).toHaveLength(1);
  const click = async (offset: number) => act(async () => {
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100 + offset * 8, clientY: 60 }));
  });
  return { screen, click, onFocus, onOpen, onOpenThreadList };
}

describe('web passage click routing', () => {
  it.each([1000, 400])('opens Conversations rather than the first overlapping thread at width %s', async width => {
    const { click, onFocus, onOpen, onOpenThreadList } = await mountPassages(width);
    await click(12);
    expect(onOpenThreadList).toHaveBeenCalledOnce();
    expect(onFocus).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([1000, 400])('keeps unique-thread clicks and leaves a noncollapsed text selection alone at width %s', async width => {
    const { screen, click, onFocus, onOpen, onOpenThreadList } = await mountPassages(width);
    await click(3);
    expect(width === 1000 ? onFocus : onOpen).toHaveBeenCalledWith('paragraph');
    expect(width === 1000 ? onOpen : onFocus).not.toHaveBeenCalled();
    onFocus.mockClear();
    onOpen.mockClear();
    const selected = document.createRange();
    selected.setStart(body.firstChild!, 9);
    selected.setEnd(body.firstChild!, 26);
    document.getSelection()!.addRange(selected);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    expect(screen.findAllHostsByTestId('artifact:passage-comment')).toHaveLength(1);
    await click(12);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenThreadList).not.toHaveBeenCalled();
    expect(document.getSelection()!.toString()).toBe(markdown.slice(9, 26));
    await act(async () => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await click(60);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenThreadList).not.toHaveBeenCalled();
  });
});

describe('web passage re-attachment', () => {
  it('hands the selection, captured at the current revision, to the thread being re-attached instead of starting a comment', async () => {
    const complete = vi.fn();
    const { screen } = await mountPassages(1000, { discussionId: 'thread-1', complete });
    const selected = document.createRange();
    selected.setStart(body.firstChild!, 9);
    selected.setEnd(body.firstChild!, 26);
    document.getSelection()!.addRange(selected);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    const action = screen.findAllHostsByTestId('artifact:passage-comment')[0]!;
    expect(screen.getTextContent()).toContain('Attach here');
    await act(async () => { action.props.onPress(); });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]![0]).toMatchObject({
      ref: { kind: 'doc', artifactId: 'runbook', serverId: 'home' },
      revision: { headerVersion: 1, bodyVersion: 1 },
      range: { start: 9, end: 26 },
      quote: markdown.slice(9, 26),
    });
  });
});

describe('web changed passages without a margin', () => {
  it('shows the changed passage\'s own card above the body, and no placed thread, where no margin fits', async () => {
    const { screen } = await mountPassages(400);
    expect(screen.findAllHostsByTestId('artifact:passage-margin')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('artifact:passage-changed')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('card:moved')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('card:paragraph')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('card:quote')).toHaveLength(0);
  });

  it('leaves the changed passage to the margin when the margin fits, so its card is drawn once', async () => {
    const { screen } = await mountPassages(1000);
    expect(screen.findAllHostsByTestId('artifact:passage-changed')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('card:moved')).toHaveLength(1);
  });

  it('hands a narrow selection to the thread being re-attached through the same capture', async () => {
    const complete = vi.fn();
    const { screen } = await mountPassages(400, { discussionId: 'moved', complete });
    const selected = document.createRange();
    selected.setStart(body.firstChild!, 9);
    selected.setEnd(body.firstChild!, 26);
    document.getSelection()!.addRange(selected);
    await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
    await act(async () => { screen.findAllHostsByTestId('artifact:passage-comment')[0]!.props.onPress(); });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]![0]).toMatchObject({ range: { start: 9, end: 26 }, quote: markdown.slice(9, 26) });
  });
});
