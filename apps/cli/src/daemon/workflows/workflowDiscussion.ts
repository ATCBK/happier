import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { readCommittedDiscussionMessage } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { readWorkflowDiscussionContextV1 } from '@happier-dev/protocol/workflows';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions/references';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { StoredCredentials } from '@/persistence';
import { WorkflowInputResolutionError, type WorkflowValueResolutionRuntime } from './input';

type DiscussionAction = NonNullable<ActionExecutorDeps['discussionAction']>;
type DiscussionOrigin = Readonly<{ discussion: DiscussionAddressV1; messageId: string; throughSeq: number }>;

/** Resolve a committed occurrence through C3; caller text and local ids supply no frontier. */
export async function resolveWorkflowDiscussionOrigin(params: Readonly<{
  origin: Readonly<{ kind: 'discussion'; discussion: DiscussionAddressV1; addressingMessageId: string }>;
  context: ActionExecutorContext;
  discussionAction: DiscussionAction;
  signal?: AbortSignal;
}>): Promise<DiscussionOrigin> {
  const { origin } = params;
  const context = { ...params.context, ...(params.signal ? { signal: params.signal } : {}) };
  if (!context.serverId || !areServerProfileIdentifiersEquivalent(context.serverId, origin.discussion.serverId)) {
    throw new WorkflowInputResolutionError('invalid_reference_scope');
  }
  const read = await readCommittedDiscussionMessage({ kind: 'discussion', discussion: origin.discussion,
    messageId: origin.addressingMessageId }, context, params.discussionAction);
  if (!read.ok || !read.message.content || read.message.messageRef.messageId !== origin.addressingMessageId
    || read.message.messageRef.discussion.discussionId !== origin.discussion.discussionId) {
    throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
  }
  return { discussion: origin.discussion, messageId: read.message.id, throughSeq: read.message.seq };
}

/** The canonical Discussion codec/access reader owns every page; the invocation owns the chosen input. */
export function createProductionWorkflowDiscussionContextReader(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  origin: DiscussionOrigin | undefined;
  signal?: AbortSignal;
}>): Required<Pick<WorkflowValueResolutionRuntime, 'resolveDiscussionContext'>> {
  const discussionAction = createDiscussionActionDeps({ credentials: params.credentials,
    serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl }).discussionAction!;
  return { resolveDiscussionContext: async scope => {
    try {
      params.signal?.throwIfAborted();
      const origin = params.origin;
      if (!origin || !areServerProfileIdentifiersEquivalent(params.serverId, origin.discussion.serverId)) {
        throw new WorkflowInputResolutionError('invalid_reference_scope');
      }
      const read = await readWorkflowDiscussionContextV1({ origin, scope, discussionAction,
        context: { surface: 'api', authority: 'account_automation', serverId: params.serverId,
          ...(params.signal ? { signal: params.signal } : {}) } });
      if (!read.ok) throw new WorkflowInputResolutionError(read.code);
      return StrictJsonValueSchema.parse(read.context);
    } catch (error) {
      if (params.signal?.aborted || error instanceof WorkflowInputResolutionError) throw error;
      throw new WorkflowInputResolutionError('workflow_discussion_context_unavailable');
    }
  } };
}
