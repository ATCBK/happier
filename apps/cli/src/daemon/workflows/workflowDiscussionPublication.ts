import type { WorkflowDiscussionOriginV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import type { DiscussionReplyReturnPublisher, DiscussionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { projectSessionMessageReplyOutcome, readSessionMessageReply } from '@/session/services/sessionMessageReply';
import type { StoredCredentials } from '@/persistence';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import { projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';

/** Known refusal is actionable; an unacknowledged transport remains uncertain. */
export class WorkflowDiscussionPublicationUnavailable extends Error {
  readonly terminal: boolean;
  constructor(readonly code = 'workflow_discussion_publication_unavailable') {
    super('workflow_discussion_publication_unavailable');
    this.terminal = ['workflow_authorization_revoked', 'discussion_not_found', 'discussion_archived',
      'discussion_read_denied', 'discussion_post_denied', 'discussion_access_forbidden',
      'discussion_invalid_content', 'discussion_invalid_reply_target', 'discussion_invalid_mention',
      'discussion_idempotency_conflict'].includes(code);
  }
}

/** Workflow consumes C2's original input and C3's sole publisher after accepting the exact result. */
export function createWorkflowDiscussionResultPublisher(params: Readonly<{
  credentials: StoredCredentials;
  origin: WorkflowDiscussionOriginV1;
  publish: DiscussionReplyReturnPublisher;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
}>) {
  const publish = async (publication: DiscussionReplyReturnPublication) => {
    const published = await params.publish(publication, params.signal ? { signal: params.signal } : undefined);
    if (!published.ok) throw new WorkflowDiscussionPublicationUnavailable(published.error);
  };
  return async ({ runId, invocation, expectedParentRevision }: Readonly<{ runId: string; invocation: WorkflowCoordinatorInvocation;
    expectedParentRevision?: number }>): Promise<void> => {
    if (!['step', 'action'].includes(invocation.blockKind ?? '')
      || !['completed', 'failed', 'cancelled'].includes(invocation.lifecycle)) return;
    // A retained draft that has not been published stays under its review owner.
    if (invocation.review && invocation.lifecycle !== 'completed' && invocation.review.decision?.kind !== 'use_result') return;
    params.signal?.throwIfAborted();
    if (!await params.isCurrent(params.signal)) throw new WorkflowDiscussionPublicationUnavailable('workflow_authorization_revoked');
    const execution = invocation.execution;
    const resultDestination = invocation.discussionReplyTo ?? params.origin;
    // Accepted result delivery also carries its routing discriminator. Only
    // the committed C3 frontier belongs in the strict Machine origin envelope.
    const expectedOrigin: WorkflowDiscussionOriginV1 = { discussion: resultDestination.discussion,
      messageId: resultDestination.messageId, throughSeq: resultDestination.throughSeq };
    const workflow = { runId, invocationRecordId: invocation.recordId, invocationAttempt: String(invocation.attempt) };
    const content = projectWorkflowDiscussionResultContentV1({ ...workflow, lifecycle: invocation.lifecycle,
      ...(invocation.result !== undefined ? { result: invocation.result } : {}) });
    if (execution?.kind !== 'session') {
      const producer = projectWorkflowDiscussionProducerV1({ ...workflow, blockKind: invocation.blockKind ?? '',
        lifecycle: invocation.lifecycle, ...(execution ? { execution } : {}),
        ...(invocation.result !== undefined ? { result: invocation.result } : {}) });
      if (!producer) throw new WorkflowDiscussionPublicationUnavailable();
      await publish({ kind: 'workflow_invocation', serverId: params.origin.discussion.serverId,
        workflow, discussion: expectedOrigin, producer, content,
        ...(expectedParentRevision !== undefined ? { expectedParentRevision } : {}) });
      return;
    }
    const original = await readSessionMessageReply({ credentials: params.credentials, sessionId: execution.sessionId,
      localId: execution.localInputId, ...(params.signal ? { signal: params.signal } : {}) });
    const progress = original.status === 'available' ? original.progress : undefined;
    const destination = progress?.discussion;
    if (!progress || !destination || !progress.outcome
      || progress.workflow?.runId !== runId || progress.workflow.invocationRecordId !== invocation.recordId
      || destination.discussionId !== expectedOrigin.discussion.discussionId
      || destination.messageId !== expectedOrigin.messageId || destination.throughSeq !== expectedOrigin.throughSeq
      || destination.participantSessionId !== execution.sessionId) throw new WorkflowDiscussionPublicationUnavailable();
    if (progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome) return;
    if (progress.disposition === 'returned') return;
    if (progress.outcome.kind === 'declined') return;
    const pass = progress.outcome.kind !== 'answer' ? await projectSessionMessageReplyOutcome({ credentials: params.credentials,
      serverId: params.origin.discussion.serverId, sessionId: execution.sessionId, localId: execution.localInputId,
      outcome: progress.outcome, ...(params.signal ? { signal: params.signal } : {}) }) : undefined;
    if (progress.outcome.kind !== 'answer' && !pass) throw new WorkflowDiscussionPublicationUnavailable();
    await publish({ serverId: params.origin.discussion.serverId,
      requestSessionId: execution.sessionId, requestLocalId: execution.localInputId,
      ...(progress.acceptedTurnId ? { acceptedTurnId: progress.acceptedTurnId } : {}), discussion: destination, outcome: progress.outcome,
      workflow,
      ...(progress.actionRequestAttributionV1 ? { actionRequestAttributionV1: progress.actionRequestAttributionV1 } : {}),
      message: pass ? pass.message : typeof invocation.result === 'string' ? invocation.result : 'Workflow result',
      ...(!pass ? { content } : {}),
    });
  };
}
