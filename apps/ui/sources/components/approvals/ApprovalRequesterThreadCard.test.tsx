import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';

import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({
  text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);

afterEach(async () => {
  await standardCleanup();
});

const THREAD = 'detailPages.approval.requester.thread';
const { ApprovalRequesterThreadCard } =
  await import('./ApprovalRequesterThreadCard');

const personalUse: ActionOperationCredentialUseV1 = {
  v: 1,
  kind: 'connected_account',
  label: 'Acme GitHub',
  owner: { kind: 'account', accountId: 'alice' },
  service: { pluginId: 'happier.integration.github', localId: 'github' },
  why: {
    kind: 'purpose_binding',
    purpose: {
      consumer: { pluginId: 'happier.integration.github', localId: 'issues' },
      purpose: 'write',
    },
    target: 'account',
  },
  currentness: { kind: 'current_at_materialization' },
};
const teamUse: ActionOperationCredentialUseV1 = {
  ...personalUse,
  kind: 'team_resource',
  label: null,
  owner: { kind: 'team', teamId: 'team-release' },
  currentness: { kind: 'current_at_materialization', resourceRevision: 3 },
};

const decided = (request: ApprovalRequestV2): ApprovalRequestV2 => ({
  ...request,
  status: 'approved',
  updatedAtMs: 20,
  decision: {
    kind: 'approve',
    decidedAtMs: 20,
    authority: 'present_user',
    decidingAccountId: 'bob',
  },
});

function approvalOf(
  settle?: (request: ApprovalRequestV2) => ApprovalRequestV2,
) {
  const [entry] = listDiscussionRequesterApprovals(
    [buildDiscussionRequesterApprovalArtifact({ settle })],
    { serverId: 'server-1', discussionId: 'discussion-1' },
  );
  if (!entry) throw new Error('Expected the requester approval');
  return entry;
}

const executed =
  (uses?: readonly ActionOperationCredentialUseV1[]) =>
  (request: ApprovalRequestV2): ApprovalRequestV2 => ({
    ...decided(request),
    status: 'executed',
    updatedAtMs: 30,
    execution: {
      executedAtMs: 30,
      ok: true,
      effectAttempted: true,
      result: { ok: true },
      ...(uses ? { operationCredentialUses: [...uses] } : {}),
    },
  });

async function renderCard(
  settle?: (request: ApprovalRequestV2) => ApprovalRequestV2,
) {
  return renderScreen(
    <ApprovalRequesterThreadCard
      approval={approvalOf(settle)}
      serverId="server-1"
    />,
  );
}

describe('ApprovalRequesterThreadCard operation actor', () => {
  it('says the admitted credential the operation used, apart from who asked and who confirmed', async () => {
    const screen = await renderCard(executed([personalUse]));
    const line = screen.findByTestId(
      'approval-operation-actor',
    );
    expect(line).toBeTruthy();
    expect(screen.getTextContent()).toContain(`${THREAD}.using(label=Acme GitHub)`);
    // The original outcome stays exact.
    expect(
      screen.findByTestId('approval-requester-thread-receipt-done'),
    ).toBeTruthy();
  });

  it('keeps owner and why behind the line until asked', async () => {
    const screen = await renderCard(executed([personalUse]));
    expect(screen.getTextContent()).not.toContain(`${THREAD}.ownerAccount`);
    await screen.pressByTestIdAsync(
      'approval-operation-actor',
    );
    expect(screen.getTextContent()).toContain(`${THREAD}.ownerAccount`);
    expect(screen.getTextContent()).toContain(`${THREAD}.why`);
  });

  it('names an unlabeled Team resource by its kind, never by a guessed identity', async () => {
    const screen = await renderCard(executed([teamUse]));
    expect(screen.getTextContent()).toContain(`${THREAD}.usingTeam`);
    expect(screen.getTextContent()).not.toContain('Acme GitHub');
  });

  it('draws nothing without admitted evidence, and never from the execution Account', async () => {
    for (const settle of [undefined, decided, executed(undefined)]) {
      const screen = await renderCard(settle);
      expect(
        screen.findByTestId('approval-operation-actor'),
      ).toBeNull();
      expect(
        screen.findByTestId('approval-requester-thread-writes-with'),
      ).toBeNull();
      expect(screen.getTextContent()).not.toContain(`${THREAD}.using`);
      expect(screen.getTextContent()).not.toContain('writesWith');
    }
  });
});
