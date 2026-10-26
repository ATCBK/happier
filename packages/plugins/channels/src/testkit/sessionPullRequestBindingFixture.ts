import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';

export function sessionPullRequestBindingFixture(id: string, sessionId: string, number: number,
  state?: 'open' | 'merged' | 'closed') {
  const binding = ConversationBindingV1Schema.parse({
    v: 1, id, createdAt: 1, updatedAt: 1, connectionId: 'connection-1',
    endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${number}`,
      pullRequest: { repository: 'acme/widgets', number },
      ...(state ? { pullRequestState: { state, observedAt: 10 } } : {}) },
    target: { kind: 'session', sessionId, pullRequestLink: { repository: 'acme/widgets', number },
      policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
    allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly',
    inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
    enabled: false, deletionState: 'none',
  });
  const { id: bindingId, v, connectionId, createdAt, updatedAt, ...payload } = binding;
  return { id: bindingId, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': bindingId,
    'session-id': sessionId, 'created-at': createdAt, 'updated-at': updatedAt, payload };
}

