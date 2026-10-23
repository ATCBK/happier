import { describe, expect, it } from 'vitest';
import { createWorkflowDiscussionResultPublisher } from './workflowDiscussionPublication';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import type { StoredCredentials } from '@/persistence';
import type { DiscussionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { WorkflowResultDeliveryV1Schema } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { DiscussionAgentApprovedReplayPublicationV1Schema } from '@happier-dev/protocol/discussions/api';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';

const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
const invocation = (extra: Partial<WorkflowCoordinatorInvocation> = {}): WorkflowCoordinatorInvocation => ({
  key: 'leaf', recordId: 'invocation', runId: 'run', blockId: 'check', path: { blockId: 'check', scope: [] }, attempt: 0,
  acceptedAtMs: 0, blockKind: 'action', lifecycle: 'completed',
  execution: { kind: 'action', actionId: 'plugin:external/check', actionRequestId: 'action-request', localInputId: 'input', input: {} }, result: { checked: true }, ...extra,
});
describe('Workflow Discussion accepted-result publication', () => {
  it('projects an accepted tagged result destination into the strict Machine publication origin', async () => {
    const destination = WorkflowResultDeliveryV1Schema.parse({ kind: 'originating_discussion', ...origin });
    if (destination.kind !== 'originating_discussion') throw new Error('Expected Discussion result destination');
    const packets: unknown[] = [];
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test', encryption: null },
      origin: destination, isCurrent: async () => true, publish: async publication => {
        if (!('kind' in publication)) throw new Error('Expected non-Session Workflow publication');
        packets.push({ v: 1, operation: 'workflow_result', machineId: 'machine', publication: {
          discussionId: publication.discussion.discussion.discussionId, origin: publication.discussion,
          producer: publication.producer, request: { localId: deriveWorkflowDiscussionReplyLocalIdV1(publication.workflow),
            content: { t: 'plain', v: publication.content }, mentionedAccountIds: [],
            replyTarget: { kind: 'message', messageId: publication.discussion.messageId } },
        } });
        return { v: 1, ok: false, error: 'discussion_post_denied' };
      } });
    await expect(publish({ runId: 'run', invocation: invocation() })).rejects.toThrow('workflow_discussion_publication_unavailable');
    expect(packets).toHaveLength(1);
    expect(DiscussionAgentApprovedReplayPublicationV1Schema.safeParse(packets[0]).success).toBe(true);
  });
  it('omits aggregate rows and private review-held drafts', async () => {
    const publications: DiscussionReplyReturnPublication[] = [];
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test' } as StoredCredentials,
      origin, isCurrent: async () => true, publish: async input => { publications.push(input); throw new Error('unexpected'); } });
    await publish({ runId: 'run', invocation: invocation({ blockKind: 'parallel' }) });
    await publish({ runId: 'run', invocation: invocation({ lifecycle: 'waiting_for_review' }) });
    await publish({ runId: 'run', invocation: invocation({ lifecycle: 'cancelled', result: 'PRIVATE-DRAFT',
      review: { resultSource: { kind: 'published', by: 'agent' } } }) });
    expect(publications).toEqual([]);
  });
  it('publishes an authorized completed review generation without a copied prior decision', async () => {
    let offered = false;
    const publish = createWorkflowDiscussionResultPublisher({ credentials: { token: 'test' } as StoredCredentials,
      origin, isCurrent: async () => true, publish: async () => { offered = true; return { v: 1, ok: false, error: 'discussion_post_denied' }; } });
    await expect(publish({ runId: 'run', invocation: invocation({ review: { resultSource: { kind: 'execution_input' } } }) }))
      .rejects.toThrow('workflow_discussion_publication_unavailable');
    expect(offered).toBe(true);
  });
});
