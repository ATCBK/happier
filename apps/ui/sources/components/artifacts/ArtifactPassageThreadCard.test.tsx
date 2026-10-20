import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { DocPassageMarginThread } from './docPassageMargin';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock().module;
});

const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactPassageThreadCard } = await import('./ArtifactPassageThreadCard');

afterEach(() => standardCleanup());

const ref = { kind: 'doc' as const, artifactId: 'runbook', serverId: 'home' };
const firstPassage: DocPassageRefV1 = { ref, revision: { headerVersion: 1, bodyVersion: 2 }, range: { start: 0, end: 11 }, quote: 'Up to 5 tries' };
const laterPassage: DocPassageRefV1 = { ref, revision: { headerVersion: 1, bodyVersion: 5 }, range: { start: 4, end: 20 }, quote: 'Up to 3 attempts' };
const root: DiscussionOpenedMessageV1 = {
  id: 'm1', discussionId: 'thread-1', seq: 1, authorAccountId: 'ben', accountActor: null, createdAt: 1,
  localId: null, mentionedAccountIds: [],
  messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'thread-1' }, messageId: 'm1' },
  replyTarget: { kind: 'doc_passage', doc: { ref, revision: firstPassage.revision } },
  content: { kind: 'doc_passage_comment', passage: firstPassage, content: { v: 1, parts: [{ t: 'text', text: 'Still right?' }] } },
};
const thread = (
  location: DocPassageMarginThread['location'], passage: DocPassageRefV1 = firstPassage,
): DocPassageMarginThread<DiscussionOpenedMessageV1> => ({ discussionId: 'thread-1', passage, original: firstPassage, location, root,
  replies: [], proposal: null, acceptedProposal: null });

async function mount(input: Readonly<{ thread: DocPassageMarginThread<DiscussionOpenedMessageV1>; attaching?: boolean }>) {
  const handlers = { onReattach: vi.fn(), onCancelReattach: vi.fn(), onOpenHistory: vi.fn() };
  const screen = await renderScreen(
    <ArtifactPassageThreadCard thread={input.thread} focused={false} attaching={input.attaching === true}
      client={createArtifactActionsClient({ serverId: 'home', accountId: 'alice' }, vi.fn() as never)}
      docRead={{ status: 'loading' }} mountThread={() => () => {}} viewerAccountId="alice"
      onFocus={() => {}} onOpen={() => {}} {...handlers} />,
  );
  return { screen, ...handlers };
}
const id = 'artifact:passage-thread:thread-1';

describe('ArtifactPassageThreadCard re-attachment', () => {
  it('offers to attach a changed passage to new text, beside its revision, and asks for the selection while attaching', async () => {
    const view = await mount({ thread: thread({ state: 'detached' }) });
    expect(view.screen.findByTestId(`${id}.compare`)).not.toBeNull();
    await act(async () => view.screen.findByTestId(`${id}.reattach`)!.props.onPress());
    expect(view.onReattach).toHaveBeenCalledOnce();
    const attaching = await mount({ thread: thread({ state: 'detached' }), attaching: true });
    expect(attaching.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(attaching.screen.findByTestId(`${id}.reattaching`)).not.toBeNull();
    await act(async () => attaching.screen.findByTestId(`${id}.reattach-cancel`)!.props.onPress());
    expect(attaching.onCancelReattach).toHaveBeenCalledOnce();
  });

  it('offers nothing for a passage that is still placed and keeps the original quote and version of a re-attached thread', async () => {
    const placed = await mount({ thread: thread({ state: 'exact', range: { start: 0, end: 11 } }) });
    expect(placed.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(placed.screen.findByTestId(`${id}.earlier`)).toBeNull();
    const moved = await mount({ thread: thread({ state: 'exact', range: laterPassage.range }, laterPassage) });
    expect(moved.screen.findByTestId(`${id}.reattach`)).toBeNull();
    expect(moved.screen.getTextContent()).toContain('Up to 3 attempts');
    expect(moved.screen.findByTestId(`${id}.earlier`)).not.toBeNull();
    expect(moved.screen.getTextContent()).toContain('Up to 5 tries');
  });
});
