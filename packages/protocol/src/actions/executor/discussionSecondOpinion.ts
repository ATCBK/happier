import { DiscussionCreateInputV1Schema, DiscussionCreateResultV1Schema, DiscussionInviteResultV1Schema, DiscussionPostInputV1Schema, DiscussionPostResultV1Schema,
  type DiscussionCreateInputV1 } from '../../discussions/actions.js';
import { DiscussionSecondOpinionStartInputV1Schema, type DiscussionSecondOpinionStartResultV1 } from '../../discussions/secondOpinionActions.js';
import { DiscussionSecondOpinionPreviewResponseV1Schema, type DiscussionSecondOpinionPreviewInputV1,
  type DiscussionSecondOpinionPreviewV1, type DiscussionSecondOpinionSourceV1 } from '../../discussions/secondOpinion.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { locateDocPassageV1 } from '../../artifacts/artifactPassageV1.js';
import { DocReadResultV1Schema } from '../../artifacts/artifactCollaborationActionsV1.js';
import { SessionSpawnNewResultV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import type { DiscussionAddressV1 } from '../../discussions/references.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { ActionApprovalRequestCreatedResultSchema } from '../actionExecutionResult.js';
import type { ActionId } from '../actionIds.js';
import { SessionTranscriptGetResultSchema } from '../actionSpecs.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

type ExecuteChild = (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
function failure(errorCode: string): ActionExecuteResult { return { ok: false, errorCode, error: errorCode }; }
function refuse(errorCode: string): never { throw Object.assign(new Error(errorCode), { code: errorCode }); }

/** Preview sends identities only. Passage text stays with its key-holding source reader. */
export function projectDiscussionSecondOpinionPreviewInputV1(input: Readonly<{
  source: DiscussionSecondOpinionSourceV1;
  reviewers: DiscussionSecondOpinionPreviewInputV1['reviewers'];
  participants?: DiscussionSecondOpinionPreviewInputV1['participants'];
  publisherSessionId?: string;
}>): DiscussionSecondOpinionPreviewInputV1 {
  return { source: input.source.kind === 'session' ? input.source : projectDocPassageSource(input.source.passage),
    reviewers: input.reviewers, ...(input.participants ? { participants: input.participants } : {}),
    ...(input.publisherSessionId ? { publisherSessionId: input.publisherSessionId } : {}) };
}

/** The preview routes by the qualified Doc only; callers resolve an omitted Home before preview (C5 §4). */
function projectDocPassageSource(passage: Extract<DiscussionSecondOpinionSourceV1, { kind: 'doc_passage' }>['passage']) {
  const { serverId } = passage.ref;
  if (!serverId) refuse('discussion_invalid_content');
  return { kind: 'doc_passage' as const, doc: { ref: { ...passage.ref, serverId }, revision: passage.revision } };
}

/** The ordinary create writer serves both Discuss and Second opinion; no second conversation store. */
export function prepareAnchoredDiscussionCreateV1(input: Readonly<{
  source: DiscussionSecondOpinionSourceV1; title: string; quote: string;
  creationLocalId: string; quoteLocalId: string; participants?: DiscussionCreateInputV1['participants'];
}>): DiscussionCreateInputV1 {
  const text = { v: 1 as const, parts: [{ t: 'text' as const, text: input.quote.normalize('NFC') }] };
  return DiscussionCreateInputV1Schema.parse({ title: input.title, creationLocalId: input.creationLocalId,
    ...(input.participants ? { participants: input.participants } : {}),
    anchor: input.source.kind === 'session' ? { kind: 'session', sessionId: input.source.message.session.sessionId,
      messageId: input.source.message.messageId } : { kind: 'doc',
      doc: { ref: input.source.passage.ref, revision: input.source.passage.revision } },
    firstMessage: { localId: input.quoteLocalId, content: input.source.kind === 'session' ? text
      : { kind: 'doc_passage_comment', passage: input.source.passage, content: text },
      ...(input.source.kind === 'doc_passage' ? { replyTarget: { kind: 'doc_passage',
        doc: { ref: input.source.passage.ref, revision: input.source.passage.revision } } } : {}) },
  });
}

/** One concrete mention creates the ordinary U2 addressed occurrence. The quote is its exact parent. */
export function prepareSecondOpinionQuestionV1(input: Readonly<{
  discussionId: string; sessionId: string; question: string; questionLocalId: string; quoteMessageId: string;
}>) {
  return DiscussionPostInputV1Schema.parse({ discussionId: input.discussionId, localId: input.questionLocalId,
    content: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: input.sessionId } },
      { t: 'text', text: ` ${input.question}` }] },
    replyTarget: { kind: 'message', messageId: input.quoteMessageId },
  });
}

/** Reads the exact committed source under its ordinary owner; missing keys/text never become an authored quote. */
export async function readDiscussionSecondOpinionSourceV1(source: DiscussionSecondOpinionSourceV1,
  execute: ExecuteChild, context: ActionExecutorContext): Promise<string> {
  if (source.kind === 'doc_passage') {
    const result = await execute('doc.read', { ref: source.passage.ref, revision: source.passage.revision }, context);
    if (!result.ok) refuse(result.errorCode);
    const doc = DocReadResultV1Schema.safeParse(result.result);
    if (!doc.success || typeof doc.data.artifact.body !== 'string'
      || doc.data.ref.artifactId !== source.passage.ref.artifactId
      || doc.data.ref.serverId !== source.passage.ref.serverId
      || locateDocPassageV1({ target: source.passage, source: doc.data.artifact.body,
        revision: doc.data.artifact.revision }).state !== 'exact') refuse('discussion_content_unavailable');
    return source.passage.quote;
  }
  let cursor: string | null = null;
  for (;;) {
    const result = await execute('session.transcript.get', { sessionId: source.message.session.sessionId,
      ...(cursor ? { cursor } : {}), includeTools: false, includeReasoning: false, includeEvents: false,
      maxCharsPerMessage: null }, context);
    if (!result.ok) refuse(result.errorCode);
    const parsed = SessionTranscriptGetResultSchema.safeParse(result.result);
    if (!parsed.success) refuse('invalid_action_output');
    const value = parsed.data;
    if (!value.ok) refuse(value.errorCode);
    if (!('items' in value) || 'projection' in value || value.sessionId !== source.message.session.sessionId) refuse('discussion_content_unavailable');
    const item = value.items.find(row => row.id === source.message.messageId);
    if (item) {
      if (item.truncated || item.semanticRole !== 'assistant' || typeof item.text !== 'string' || !item.text.trim()) {
        refuse('discussion_content_unavailable');
      }
      return item.text.normalize('NFC');
    }
    if (!value.hasMore || !value.nextCursor || value.nextCursor === cursor) refuse('discussion_content_unavailable');
    cursor = value.nextCursor;
  }
}

/** A grant already committed by this retry may fill a planned gap; it may never add a new disclosure recipient. */
function matchesConfirmedPreview(current: DiscussionSecondOpinionPreviewV1, confirmed: DiscussionSecondOpinionPreviewV1): boolean {
  if (!sameStrictJsonValue(current.source, confirmed.source) || current.reviewers.length !== confirmed.reviewers.length
    || !sameStrictJsonValue(current.discussionAudienceAccountIds, confirmed.discussionAudienceAccountIds)
    || !sameStrictJsonValue(current.publisher, confirmed.publisher)) return false;
  return current.reviewers.every((reviewer, index) => {
    const prior = confirmed.reviewers[index]!;
    return sameStrictJsonValue(reviewer.selection, prior.selection) && reviewer.sourceAccess === prior.sourceAccess
      && reviewer.runtimeAccountId === prior.runtimeAccountId && reviewer.participantSlotId === prior.participantSlotId
      && sameStrictJsonValue(reviewer.audienceAccountIds, prior.audienceAccountIds)
      && reviewer.missingSourceAccountIds.every(id => prior.missingSourceAccountIds.includes(id));
  });
}

/** Composes existing admitted owners; it owns no grant, native turn, key, queue or retry ledger. */
export async function executeDiscussionSecondOpinionV1(input: unknown, deps: ActionExecutorDeps,
  context: ActionExecutorContext, execute: ExecuteChild,
  isSameHome: (serverId: string) => boolean): Promise<ActionExecuteResult> {
  const authored = DiscussionSecondOpinionStartInputV1Schema.parse(input);
  const actualPublisher = context.actionCaller?.kind === 'session' ? context.actionCaller.sessionId
    : context.surface === 'agent' ? context.defaultSessionId : undefined;
  if (authored.publisherSessionId !== undefined && authored.publisherSessionId !== actualPublisher) return failure('discussion_post_denied');
  const request = { ...authored, ...(actualPublisher ? { publisherSessionId: actualPublisher } : {}) };
  if (request.reviewers.length > 1) return { ok: true, result: {
    status: 'unavailable', reason: 'fresh_opinions_unavailable', mode: 'fresh_opinions',
  } satisfies DiscussionSecondOpinionStartResultV1 };
  const sourceServerId = request.source.kind === 'session' ? request.source.message.session.serverId : request.source.passage.ref.serverId;
  if (!sourceServerId || !isSameHome(sourceServerId) || request.reviewers.some(({ selection }) => !isSameHome(
    selection.kind === 'session' ? selection.session.serverId : selection.launch.executionTarget.serverId))) return failure('server_target_mismatch');
  if (!deps.discussionAction) return failure('unsupported_action');
  const grantedAccountIds: string[] = [];
  let discussion: DiscussionAddressV1 | undefined;
  let stage: 'grant' | 'create' | 'invite' | 'ask' = 'grant';
  const pending = (errorCode: string): ActionExecuteResult => ({ ok: true, result: {
    status: 'pending', stage, errorCode, grantedAccountIds, ...(discussion ? { discussion } : {}),
  } satisfies DiscussionSecondOpinionStartResultV1 });
  const preview = async () => {
    const raw = await deps.discussionAction!({ actionId: 'discussion.second_opinion.start',
      input: { ...request, intent: 'preview' }, context, ...(context.signal ? { signal: context.signal } : {}) });
    const parsed = DiscussionSecondOpinionPreviewResponseV1Schema.safeParse(raw);
    if (!parsed.success) {
      if (raw && typeof raw === 'object' && 'errorCode' in raw && typeof raw.errorCode === 'string') refuse(raw.errorCode);
      refuse('invalid_action_output');
    }
    if (!parsed.data.ok) refuse(parsed.data.error);
    const value = parsed.data.value;
    if (!sameStrictJsonValue(value.source, projectDiscussionSecondOpinionPreviewInputV1(request).source)
      || value.publisher?.sessionId !== actualPublisher
      || value.reviewers.length !== request.reviewers.length
      || value.reviewers.some((reviewer, index) => !sameStrictJsonValue(reviewer.selection, request.reviewers[index]!.selection)
        || (request.reviewers[index]!.sourceAccess !== undefined && reviewer.sourceAccess !== request.reviewers[index]!.sourceAccess))) {
      refuse('invalid_action_output');
    }
    return value;
  };
  try {
    let current = await preview();
    if (!current.sourceContentReady) return failure('encryption_material_unavailable');
    // Preview itself returns plaintext into the invoking Agent's native context.
    // Its audience must be admitted before opening the source, not only at Ask.
    if (current.publisher && !current.publisher.disclosure.ok) return failure('discussion_access_forbidden');
    // A person may approve in the app, but the retained result still belongs
    // to the proposing Voice operation. Keep its stricter source privacy.
    const sourceContext = context.presentUserApproval?.requestSurface === 'voice'
      ? { ...context, surface: 'voice' as const } : context;
    const quote = await readDiscussionSecondOpinionSourceV1(request.source, execute, sourceContext);
    if (request.intent === 'preview') return { ok: true, result: { status: 'preview', preview: current, sourceText: quote } };
    if (!request.confirmedPreview || !matchesConfirmedPreview(current, request.confirmedPreview)) {
      return { ok: true, result: { status: 'preview_changed', preview: current, grantedAccountIds } };
    }
    const reviewer = current.reviewers[0]!;
    if (!current.discussionDisclosure.ok || current.missingDiscussionSourceAccountIds.length) return failure('discussion_access_forbidden');
    if (reviewer.missingSourceAccountIds.length && (reviewer.sourceAccess !== 'read' || !reviewer.canGrantSource)) {
      return failure('discussion_access_forbidden');
    }
    for (const accountId of reviewer.missingSourceAccountIds) {
      const grant = request.source.kind === 'session'
        ? await execute('session.access.grant.set', { sessionId: request.source.message.session.sessionId,
          subject: { kind: 'account', accountId }, accessLevel: 'view', canApprovePermissions: false }, context)
        : await execute('artifact.access.grants.set', { artifactId: request.source.passage.ref.artifactId,
          principal: { kind: 'account', accountId }, accessLevel: 'view' }, context);
      if (!grant.ok) return pending(grant.errorCode);
      if (ActionApprovalRequestCreatedResultSchema.safeParse(grant.result).success) return pending('approval_required');
      grantedAccountIds.push(accountId);
    }
    current = await preview();
    if (!matchesConfirmedPreview(current, request.confirmedPreview)) return { ok: true, result: {
      status: 'preview_changed', preview: current, grantedAccountIds,
    } };
    if (!current.sourceContentReady) return pending('encryption_material_unavailable');
    if (!current.reviewers[0]?.disclosure.ok || current.reviewers[0].missingSourceAccountIds.length) return pending('discussion_access_forbidden');
    stage = 'create';
    const created = await execute('discussion.create', prepareAnchoredDiscussionCreateV1({ source: request.source,
      title: request.title, quote, creationLocalId: request.retry.creationLocalId, quoteLocalId: request.retry.quoteLocalId,
      participants: request.participants }), context);
    if (!created.ok) return pending(created.errorCode);
    const resource = DiscussionCreateResultV1Schema.safeParse(created.result);
    if (!resource.success || !isSameHome(resource.data.serverId)) return pending('invalid_action_output');
    discussion = { serverId: resource.data.serverId, discussionId: resource.data.discussion.id };
    stage = 'invite';
    const selected = request.reviewers[0]!;
    if (actualPublisher && (selected.selection.kind !== 'session' || selected.selection.session.sessionId !== actualPublisher)) {
      const publisher = await execute('discussion.invite', { discussionId: discussion.discussionId,
        participant: { kind: 'session', sessionId: actualPublisher }, answerPolicy: 'when_addressed' }, context);
      if (!publisher.ok) return pending(publisher.errorCode);
      if (ActionApprovalRequestCreatedResultSchema.safeParse(publisher.result).success) return pending('approval_required');
    }
    const invited = await execute('discussion.invite', { discussionId: discussion.discussionId,
      participant: selected.selection.kind === 'session'
        ? { kind: 'session', sessionId: selected.selection.session.sessionId }
        : { kind: 'model', participantSlotId: selected.participantSlotId, launch: selected.selection.launch },
      answerPolicy: 'when_addressed' }, context);
    if (!invited.ok) return pending(invited.errorCode);
    let sessionId: string;
    if (selected.selection.kind === 'session') sessionId = selected.selection.session.sessionId;
    else {
      const reservation = DiscussionInviteResultV1Schema.safeParse(invited.result);
      const resultRecord = invited.result && typeof invited.result === 'object' ? invited.result as Record<string, unknown> : {};
      const started = SessionSpawnNewResultV1Schema.safeParse(resultRecord.sessionStart);
      if (!reservation.success || !started.success || started.data.type !== 'success' || !reservation.data.modelParticipant?.sessionId) {
        return pending('outcome_unknown');
      }
      sessionId = reservation.data.modelParticipant.sessionId;
    }
    stage = 'ask';
    const asked = await execute('discussion.post', prepareSecondOpinionQuestionV1({ discussionId: discussion.discussionId,
      sessionId, question: request.question, questionLocalId: request.retry.questionLocalId, quoteMessageId: resource.data.firstMessage.id }), context);
    if (!asked.ok) return pending(asked.errorCode);
    const message = DiscussionPostResultV1Schema.safeParse(asked.result);
    if (!message.success || !sameStrictJsonValue(message.data.message.messageRef.discussion, discussion)) return pending('invalid_action_output');
    return { ok: true, result: { status: 'asked', mode: 'ask', discussion, messageRef: message.data.message.messageRef, grantedAccountIds } };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'outcome_unknown';
    return request.intent === 'preview' ? failure(code) : pending(code);
  }
}
