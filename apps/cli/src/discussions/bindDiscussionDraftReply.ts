import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { DiscussionPostInputV1Schema, DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

/** Bind explicit and terminal drafts before the existing approval owner captures their operands. */
export async function bindDiscussionDraftReply(params: Readonly<{
  actionId: string;
  input: unknown;
  context: ActionExecutorContext;
  serverId: string;
  discussionAction: ActionExecutorDeps['discussionAction'];
}>) {
  const unchanged = { actionId: params.actionId, input: params.input, context: params.context };
  const unavailable = () => ({ ...unchanged, failure: { ok: false as const,
    errorCode: 'discussion_content_unavailable', error: 'discussion_content_unavailable' } });
  const { context } = params;
  if ((params.actionId !== 'discussion.post' && params.actionId !== 'discussion.reply')
    || context.discussionReplyReturn || context.approvedActionReplay || context.signal?.aborted
    || context.serverId !== undefined && context.serverId !== params.serverId
    || context.surface !== 'agent' && context.actionCaller?.kind !== 'session') return unchanged;
  const source = SessionInputSourceSessionV1Schema.safeParse(context.sessionInputSource);
  const parsed = (params.actionId === 'discussion.reply' ? DiscussionReplyInputV1Schema : DiscussionPostInputV1Schema).safeParse(params.input);
  if (!source.success || !parsed.success || !source.data.discussionAddressing || !source.data.sourceInputId) return unchanged;
  const addressing = source.data.discussionAddressing;
  const publisherSessionId = context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId : context.defaultSessionId;
  if (publisherSessionId !== addressing.participantSessionId
    || context.defaultSessionId !== undefined && context.defaultSessionId !== publisherSessionId
    || parsed.data.discussionId !== addressing.discussionId
    || parsed.data.replyTarget && (parsed.data.replyTarget.kind !== 'message'
      || parsed.data.replyTarget.messageId !== addressing.messageId)
    || !params.discussionAction) return unchanged;
  // This is an authenticated read of the persisted participant policy. Approval
  // and publication still independently recheck it at their canonical owners.
  let rawRoster: unknown;
  try {
    rawRoster = await params.discussionAction({ actionId: 'discussion.participants.list',
      input: { discussionId: addressing.discussionId }, context, ...(context.signal ? { signal: context.signal } : {}) });
  } catch { return unavailable(); }
  const roster = DiscussionParticipantsListResponseV1Schema.safeParse(rawRoster);
  if (!roster.success || roster.data.discussionId !== addressing.discussionId || context.signal?.aborted) return unavailable();
  const participant = roster.data.participants.find(entry => entry.participant.kind === 'session'
    ? entry.participant.sessionId === publisherSessionId : 'sessionId' in entry && entry.sessionId === publisherSessionId);
  if (participant?.answerPolicy !== 'drafts_for_approval') return unchanged;
  // The verified daemon must bind a draft before signing. Other policies keep
  // their signed explicit post; an unbound signed draft must be retried there.
  if (context.externalActionExecutionAuthorization) return unavailable();
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: publisherSessionId,
    localId: source.data.sourceInputId, acceptedTurnId: source.data.sourceTurnId });
  return { actionId: 'discussion.reply', input: { ...parsed.data, localId,
    replyTarget: { kind: 'message', messageId: addressing.messageId } }, context: { ...context, actionRequestId: localId,
    discussionReplyReturn: { serverId: params.serverId, requestLocalId: source.data.sourceInputId,
      acceptedTurnId: source.data.sourceTurnId } } };
}
