import type { WorkflowDiscussionOriginV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import type { DiscussionReplyReturnPublisher } from '@/session/services/sessionMessageReply';
import { projectSessionMessageReplyOutcome, readSessionMessageReply } from '@/session/services/sessionMessageReply';
import type { StoredCredentials } from '@/persistence';
import type { WorkflowCoordinatorInvocation } from './coordinator';

/** Known refusal is actionable; an unacknowledged transport remains uncertain. */
export class WorkflowDiscussionPublicationUnavailable extends Error {
  constructor() { super('workflow_discussion_publication_unavailable'); }
}

/** Workflow consumes C2's original input and C3's sole publisher after accepting the exact result. */
export function createWorkflowDiscussionResultPublisher(params: Readonly<{
  credentials: StoredCredentials;
  origin: WorkflowDiscussionOriginV1;
  publish: DiscussionReplyReturnPublisher;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
}>) {
  return async ({ runId, invocation }: Readonly<{ runId: string; invocation: WorkflowCoordinatorInvocation }>): Promise<void> => {
    if (invocation.blockKind !== 'step' || invocation.lifecycle !== 'completed'
      || invocation.execution?.kind !== 'session' || invocation.result === undefined) return;
    params.signal?.throwIfAborted();
    if (!await params.isCurrent(params.signal)) throw new WorkflowDiscussionPublicationUnavailable();
    const execution = invocation.execution;
    const original = await readSessionMessageReply({ credentials: params.credentials, sessionId: execution.sessionId,
      localId: execution.localInputId, ...(params.signal ? { signal: params.signal } : {}) });
    const progress = original.status === 'available' ? original.progress : undefined;
    const destination = progress?.discussion;
    if (!progress || !destination || !progress.acceptedTurnId || !progress.outcome
      || progress.workflow?.runId !== runId || progress.workflow.invocationRecordId !== invocation.recordId
      || destination.discussionId !== params.origin.discussion.discussionId
      || destination.messageId !== params.origin.messageId || destination.throughSeq !== params.origin.throughSeq
      || destination.participantSessionId !== execution.sessionId) throw new WorkflowDiscussionPublicationUnavailable();
    if (progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome) return;
    if (progress.disposition === 'returned') return;
    if (!['answer', 'pass'].includes(progress.outcome.kind)) return;
    const pass = progress.outcome.kind === 'pass' ? await projectSessionMessageReplyOutcome({ credentials: params.credentials,
      serverId: params.origin.discussion.serverId, sessionId: execution.sessionId, localId: execution.localInputId,
      outcome: progress.outcome, ...(params.signal ? { signal: params.signal } : {}) }) : undefined;
    if (progress.outcome.kind === 'pass' && !pass) throw new WorkflowDiscussionPublicationUnavailable();
    const published = await params.publish({ serverId: params.origin.discussion.serverId,
      requestSessionId: execution.sessionId, requestLocalId: execution.localInputId,
      acceptedTurnId: progress.acceptedTurnId, discussion: destination, outcome: progress.outcome,
      workflow: { runId, invocationRecordId: invocation.recordId, invocationAttempt: String(invocation.attempt) },
      ...(progress.actionRequestAttributionV1 ? { actionRequestAttributionV1: progress.actionRequestAttributionV1 } : {}),
      message: pass ? pass.message
        : typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result),
    }, params.signal ? { signal: params.signal } : undefined);
    if (!published.ok) throw new WorkflowDiscussionPublicationUnavailable();
  };
}
