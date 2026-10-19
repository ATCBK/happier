import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocEditProposalV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit');
  return createTextModuleMock();
});
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit');
  return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit');
  return createModalModuleMock().module;
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { Modal } = await import('@/modal');
const { getSessionComposerDraftSnapshot, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');

afterEach(() => {
  standardCleanup();
  resetSessionDraftRepositoryForTests();
  navigation.push.mockClear();
});

const scope = { serverId: 'home', accountId: 'alice' };
const base = { headerVersion: 3, bodyVersion: 14 };
const proposal: DocEditProposalV1 = {
  target: {
    ref: { kind: 'doc', serverId: 'home', artifactId: 'runbook' },
    revision: base,
    range: { start: 0, end: 10 },
    quote: 'Two rows.!',
  },
  baseRevision: base,
  before: 'Two rows.!',
  after: 'One row with a replayed badge.',
  reason: 'Replays are recorded once now.',
};
const proposalRef: DiscussionMessageRefV1 = {
  kind: 'discussion',
  discussion: { serverId: 'home', discussionId: 'd1' },
  messageId: 'm1',
};

type Call = Readonly<{ actionId: string; input: unknown }>;
/** The Actions front door is the transport boundary to the Home; everything above it is the real client. */
function frontDoor(answers: Record<string, (input: unknown) => unknown>) {
  const calls: Call[] = [];
  const execute = vi.fn(async (actionId: string, input: unknown) => {
    calls.push({ actionId, input });
    const answer = answers[actionId];
    return answer ? answer(input) : { ok: false, errorCode: 'unexpected' };
  });
  return {
    calls,
    client: createArtifactActionsClient(scope, execute as never),
  };
}
const docRead =
  (revision: { headerVersion: number; bodyVersion: number }, access: 'owner' | 'edit' | 'view' = 'owner') => () => ({
    ok: true,
    result: {
      ref: { kind: 'doc', serverId: 'home', artifactId: 'runbook' },
      openCommentCount: 1,
      artifact: {
        artifactId: 'runbook', ownerAccountId: 'alice', access, publicAudience: 'none', header: { title: 'Runbook' },
        seq: 1, createdAt: 1, updatedAt: 2, body: 'Two rows.! Rest.', revision,
      },
    },
  });

async function render(
  client: ReturnType<typeof frontDoor>['client'],
  disposition?: React.ComponentProps<
    typeof ArtifactEditProposal
  >['disposition'],
  proposer?: React.ComponentProps<typeof ArtifactEditProposal>['proposer'],
) {
  const screen = await renderScreen(
    <ArtifactEditProposal
      testID="proposal"
      client={client}
      proposalRef={proposalRef}
      proposal={proposal}
      disposition={disposition}
      viewerAccountId="alice"
      resolveAccountLabel={() => 'Ana'}
      proposer={proposer}
    />,
  );
  await flushHookEffects();
  return screen;
}

const storedDoc = (revision: { headerVersion: number; bodyVersion: number }) => ({
  id: 'runbook', title: 'Runbook', header: { title: 'Runbook' }, isDecrypted: true as const, body: 'Two rows.! Rest.',
  ...revision, seq: 1, createdAt: 1, updatedAt: 2, ownerAccountId: 'alice', access: 'owner' as const, storageMode: 'plain' as const,
});

describe('ArtifactEditProposal', () => {
  it('follows the Doc to a newer revision: an open suggestion stops saying it is current and offers Decline, not Accept', async () => {
    getStorage().getState().addArtifact(storedDoc(base));
    let current = base;
    const door = frontDoor({
      'doc.read': () => docRead(current)(),
      'doc.edit.decline': () => ({
        ok: true,
        result: { proposalRef, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'alice', atMs: 6 } } },
      }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.current')).not.toBeNull();
    // Another suggestion on this Doc is accepted: the Doc's revision moves on.
    current = { headerVersion: 3, bodyVersion: 15 };
    await act(async () => { getStorage().getState().updateArtifact(storedDoc(current)); });
    await flushHookEffects();
    expect(screen.findByTestId('proposal.current')).toBeNull();
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.compare')).not.toBeNull();
    // A suggestion that can no longer apply can still be declined; that needs no Doc rewrite.
    await act(async () => { await screen.pressByTestIdAsync('proposal.decline'); });
    await flushHookEffects();
    expect(door.calls.find((call) => call.actionId === 'doc.edit.decline')?.input).toEqual({ proposalRef });
    expect(screen.findByTestId('proposal.declined')).not.toBeNull();
  });

  it('accepts the reviewed revision and shows the receipt at the revision the Home acknowledged', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({
        ok: true,
        result: {
          proposalRef,
          docEditProposalDispositionV1: {
            state: 'accepted',
            acceptedRevision: accepted,
            decidedBy: { accountId: 'alice', atMs: 5 },
          },
        },
      }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.current')).not.toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.accept');
    });
    await flushHookEffects();
    expect(
      door.calls.find((call) => call.actionId === 'doc.edit.accept')?.input,
    ).toEqual({ proposalRef, expectedRevision: base });
    const receipt = screen.findByTestId('proposal.accepted');
    expect(receipt).not.toBeNull();
    // The receipt names the acknowledged revision, not the reviewed one.
    expect(screen.getTextContent()).toContain('15');
    expect(screen.findByTestId('proposal.accept')).toBeNull();
  });

  it('on a phone, confirms the accepted version in the app notice with an Undo that restores it', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const { Dimensions } = await import('react-native');
    const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
    const window = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 } as never);
    try {
      const door = frontDoor({
        'doc.read': docRead(base),
        'doc.edit.accept': () => ({
          ok: true,
          result: { proposalRef, docEditProposalDispositionV1: {
            state: 'accepted', acceptedRevision: accepted, decidedBy: { accountId: 'alice', atMs: 5 } } },
        }),
        'artifact.revisions.restore': () => ({ ok: true, result: { artifactId: 'runbook', revision: { headerVersion: 3, bodyVersion: 16 } } }),
      });
      const screen = await render(door.client);
      await act(async () => {
        await screen.pressByTestIdAsync('proposal.accept');
      });
      await flushHookEffects();
      const notice = readPresentationNotice();
      expect(notice?.message).toContain('15');
      expect(notice?.undo).toBeDefined();
      await act(async () => {
        notice?.undo?.run();
      });
      await flushHookEffects();
      expect(door.calls.find((call) => call.actionId === 'artifact.revisions.restore')?.input)
        .toEqual({ artifactId: 'runbook', bodyVersion: base.bodyVersion, expectedRevision: accepted });
    } finally {
      window.mockRestore();
      retirePresentationNotice();
    }
  });

  it('says nothing was applied when the document moved on, and never offers Accept on a stale basis', async () => {
    const door = frontDoor({
      'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.compare')).not.toBeNull();
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('compares the reviewed version with the current Doc through History, not by opening the current Doc', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const screen = await render(door.client);
    await act(async () => { await screen.pressByTestIdAsync('proposal.compare'); });
    expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
      props: expect.objectContaining({ artifactId: 'runbook', compareFromBodyVersion: 14 }),
    }));
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('asks the author to redo only when pressed: an addressed reply to the suggestion waits in the same thread, unsent', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const address = { kind: 'discussion', discussionId: 'd1' } as const;
    const screen = await render(door.client, undefined, { label: 'Support runbook', mention: { sessionId: 'runbook-session' } });
    expect(getSessionComposerDraftSnapshot(scope, address)).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('proposal.askRedo'); });
    const draft = getSessionComposerDraftSnapshot(scope, address);
    expect(draft?.composer.text.value).toMatch(/^@Support runbook /);
    expect(draft?.composer.mentions.value).toEqual([{ start: 0, end: 16, sessionId: 'runbook-session' }]);
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('messageId=m1'));
    // Nothing is posted for the person: only the Doc read ran.
    expect(door.calls.map((call) => call.actionId)).toEqual(['doc.read']);
    // The suggestion itself stays: Decline is still there.
    expect(screen.findByTestId('proposal.decline')).not.toBeNull();
  });

  it('never offers to ask yourself to redo your own suggestion', async () => {
    const door = frontDoor({ 'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }) });
    const screen = await render(door.client, undefined, { label: 'You', mention: { accountId: 'alice' } });
    expect(screen.findByTestId('proposal.askRedo')).toBeNull();
  });

  it('turns a refused stale Accept into the moved-on state instead of a receipt', async () => {
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({ ok: false, errorCode: 'version_mismatch' }),
    });
    const screen = await render(door.client);
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.accept');
    });
    await flushHookEffects();
    expect(screen.findByTestId('proposal.accepted')).toBeNull();
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
  });

  it('undoes an accepted edit as a restore against the accepted revision, and refuses after a later edit', async () => {
    const accepted = { headerVersion: 3, bodyVersion: 15 };
    const door = frontDoor({
      'doc.read': docRead(accepted),
      'artifact.revisions.restore': () => ({
        ok: false,
        errorCode: 'version_mismatch',
      }),
    });
    const screen = await render(door.client, {
      state: 'accepted',
      acceptedRevision: accepted,
      decidedBy: { accountId: 'alice', atMs: 5 },
    });
    await act(async () => {
      await screen.pressByTestIdAsync('proposal.undo');
    });
    await flushHookEffects();
    expect(
      door.calls.find((call) => call.actionId === 'artifact.revisions.restore')
        ?.input,
    ).toEqual({
      artifactId: 'runbook',
      bodyVersion: 14,
      expectedRevision: accepted,
    });
    expect(screen.findByTestId('proposal.undoConflict')).not.toBeNull();
    expect(screen.findByTestId('proposal.accepted')).not.toBeNull();
  });

  it('says who can accept instead of offering Accept to someone who can only read the document', async () => {
    const door = frontDoor({ 'doc.read': docRead(base, 'view') });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.cantEdit')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
  });

  it('shows a declined proposal as settled with no decision controls', async () => {
    const door = frontDoor({ 'doc.read': docRead(base) });
    const screen = await render(door.client, {
      state: 'declined',
      decidedBy: { accountId: 'bob', atMs: 5 },
    });
    expect(screen.findByTestId('proposal.declined')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.decline')).toBeNull();
  });
});
