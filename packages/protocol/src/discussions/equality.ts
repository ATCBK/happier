import {
  SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1 as DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
  serializeCanonicalJsonForSessionMutationEqualityV1,
  deriveSessionMutationEqualityTagV1,
} from '../sessions/mutations/sessionMutationEqualityV1.js';
import {
  DiscussionMessageContentV1Schema,
  DiscussionTitleV1Schema,
  type DiscussionMessageContentV1,
  type DiscussionTitleV1,
} from './content.js';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema, type DiscussionAnchorV1, type DiscussionReplyTargetV1 } from './replyTargets.js';
import { DiscussionInitialParticipantsV1Schema, type DiscussionInitialParticipantV1 } from './participants.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

export { DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1 };

/**
 * Independent Discussion DEKs separate resources. A fixed resource namespace
 * also lets the first message keep its evidence when create is retried or its
 * committed localId is reconciled through post, before an id exists at create.
 */
export function deriveDiscussionMutationEqualityTagV1(params: Readonly<{
  dataKey: Uint8Array;
  canonicalIntent: string;
}>): string {
  return deriveSessionMutationEqualityTagV1({
    keyMaterial: params.dataKey,
    sessionId: 'discussion',
    purpose: DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
    canonicalIntent: params.canonicalIntent,
  });
}

export type DiscussionPostEqualityIntentV1 = Readonly<{
  content: DiscussionMessageContentV1;
  mentionedAccountIds: readonly string[];
  mentionedSessionIds?: readonly string[];
  replyTarget?: DiscussionReplyTargetV1;
}>;

export type DiscussionCreateEqualityIntentV1 = Readonly<{
  title: DiscussionTitleV1;
  firstMessage: DiscussionPostEqualityIntentV1 & Readonly<{ localId: string }>;
  anchor?: DiscussionAnchorV1;
  participants?: readonly DiscussionInitialParticipantV1[];
}>;

function normalizeMentionedIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

/**
 * The one canonical equality input for discussion create/post. Callers never
 * construct their own JSON or HMAC input order, and the discriminator is part
 * of the bytes so a create intent can never equal a post intent.
 *
 * The intent covers the normalized semantic request only. Randomized E2EE
 * ciphertext is deliberately excluded: it differs on every attempt and would
 * make a retried request look like a new one.
 */
export function serializeDiscussionMutationEqualityIntentV1(
  params:
    | Readonly<{ kind: 'create' }> & DiscussionCreateEqualityIntentV1
    | Readonly<{ kind: 'post' }> & DiscussionPostEqualityIntentV1,
): string {
  if (params.kind === 'create') {
    const title = DiscussionTitleV1Schema.parse(params.title);
    const content = DiscussionMessageContentV1Schema.parse(params.firstMessage.content);
    const key = (participant: DiscussionInitialParticipantV1) => participant.kind === 'account'
      ? participant.accountId : `session:${participant.sessionId}`;
    const participants = DiscussionInitialParticipantsV1Schema.parse([...(params.participants ?? [])])
      .sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
    const anchor = params.anchor === undefined ? undefined : DiscussionAnchorV1Schema.parse(params.anchor);
    const replyTarget = params.firstMessage.replyTarget === undefined ? undefined : DiscussionReplyTargetV1Schema.parse(params.firstMessage.replyTarget);
    // A Doc root already binds this exact identity/revision in its first message.
    // Publishing the same optional link must not change a retained retry's identity.
    const derivedDocAnchor = anchor?.kind === 'doc' && replyTarget?.kind === 'doc_passage'
      && sameStrictJsonValue(anchor.doc, replyTarget.doc);
    return serializeCanonicalJsonForSessionMutationEqualityV1({
      v: 1,
      kind: 'create',
      title,
      ...(anchor === undefined || derivedDocAnchor ? {} : { anchor }),
      ...(participants.length === 0 ? {} : { participants }),
      firstMessage: {
        localId: params.firstMessage.localId,
        content,
        mentionedAccountIds: normalizeMentionedIds(params.firstMessage.mentionedAccountIds),
        ...(params.firstMessage.mentionedSessionIds?.length ? { mentionedSessionIds: normalizeMentionedIds(params.firstMessage.mentionedSessionIds) } : {}),
        ...(replyTarget === undefined ? {} : { replyTarget }),
      },
    });
  }
  const content = DiscussionMessageContentV1Schema.parse(params.content);
  return serializeCanonicalJsonForSessionMutationEqualityV1({
    v: 1,
    kind: 'post',
    content,
    mentionedAccountIds: normalizeMentionedIds(params.mentionedAccountIds),
    ...(params.mentionedSessionIds?.length ? { mentionedSessionIds: normalizeMentionedIds(params.mentionedSessionIds) } : {}),
    ...(params.replyTarget === undefined ? {} : { replyTarget: DiscussionReplyTargetV1Schema.parse(params.replyTarget) }),
  });
}

