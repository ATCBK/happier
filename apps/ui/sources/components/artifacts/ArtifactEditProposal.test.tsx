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

const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');

afterEach(() => {
  standardCleanup();
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
    />,
  );
  await flushHookEffects();
  return screen;
}

describe('ArtifactEditProposal', () => {
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

  it('says nothing was applied when the document moved on, and never offers Accept on a stale basis', async () => {
    const door = frontDoor({
      'doc.read': docRead({ headerVersion: 3, bodyVersion: 16 }),
    });
    const screen = await render(door.client);
    expect(screen.findByTestId('proposal.movedOn')).not.toBeNull();
    expect(screen.findByTestId('proposal.accept')).toBeNull();
    expect(screen.findByTestId('proposal.compare')).not.toBeNull();
  });

  it('turns a refused stale Accept into the moved-on state instead of a receipt', async () => {
    const door = frontDoor({
      'doc.read': docRead(base),
      'doc.edit.accept': () => ({ ok: false, errorCode: 'version-mismatch' }),
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
        errorCode: 'version-mismatch',
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
