import {
    DiscussionAccountIdSchema,
    DiscussionTextMessageContentV1Schema,
    type DiscussionTextMessageContentV1,
    type DiscussionMessageContentV1,
} from '@happier-dev/protocol/discussions/content';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { DiscussionIdSchema } from '@happier-dev/protocol/discussions/references';
import {
    MENTION_KIND_V1,
    buildMentionRefV1,
    buildMentionRefForKindV1,
    parseMentionRefV1,
    readMentionRefOpaqueForKindV1,
} from '@happier-dev/protocol/runtime/input/mentionRefV1';

import {
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';

export type DiscussionMentionSpan = Readonly<{
    start: number;
    end: number;
} & ({ accountId: string; sessionId?: never; participantSlotId?: never }
    | { sessionId: string; accountId?: never; participantSlotId?: never }
    | { participantSlotId: string; accountId?: never; sessionId?: never })>;

/** The passage travels inside C3's admitted content, beside the human comment. */
export function prepareDiscussionContentForPassage(input: Readonly<{
    content: DiscussionMessageContentV1;
    passage: DocPassageRefV1 | null | undefined;
}>): DiscussionMessageContentV1 {
    return input.passage ? { kind: 'doc_passage_comment', passage: input.passage,
        content: DiscussionTextMessageContentV1Schema.parse(input.content) } : input.content;
}

/** Reads the immutable passage basis from already opened Discussion content. */
export function readDiscussionContentPassage(content: DiscussionMessageContentV1 | null | undefined): DocPassageRefV1 | null {
    if (!content || !('kind' in content)) return null;
    return content.kind === 'doc_passage_comment' ? content.passage : content.proposal.target;
}

/** Resolves an optional manual title without adding a second UI limit owner. */
export function resolveDiscussionCreationTitle(input: Readonly<{
    title: string;
    text: string;
    mentions?: readonly DiscussionMentionSpan[];
}>): string | null {
    const manualTitle = input.title.trim();
    if (manualTitle) return manualTitle.normalize('NFC');
    const textWithoutResolvedMentions = [...(input.mentions ?? [])]
        .sort((left, right) => right.start - left.start)
        .reduce((text, mention) => (
            mention.start >= 0 && mention.end > mention.start && mention.end <= text.length
                ? `${text.slice(0, mention.start)}${text.slice(mention.end)}`
                : text
        ), input.text);
    const derived = textWithoutResolvedMentions
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0)
        ?.trim()
        .normalize('NFC');
    return derived || null;
}

/**
 * Opens the human draft's intentionally JSON-shaped mention field into the one
 * composer representation: Account, Session or inert reserved-slot identity.
 * Invalid or overlapping spans remain ordinary text, never identity from `@label`.
 */
export function parseDiscussionMentionSpans(
    value: unknown,
    text: string,
): readonly DiscussionMentionSpan[] {
    if (!Array.isArray(value)) return [];
    const candidates = value.flatMap((entry): readonly DiscussionMentionSpan[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const keys = Object.keys(entry).sort().join(',');
        if (keys !== 'accountId,end,start' && keys !== 'end,sessionId,start' && keys !== 'end,participantSlotId,start') return [];
        const candidate = entry as Record<string, unknown>;
        const identity = keys === 'accountId,end,start'
            ? DiscussionAccountIdSchema.safeParse(candidate.accountId)
            : keys === 'end,sessionId,start' ? SessionIdSchema.safeParse(candidate.sessionId)
                : DiscussionIdSchema.safeParse(candidate.participantSlotId);
        if (
            !identity.success
            || !Number.isSafeInteger(candidate.start)
            || !Number.isSafeInteger(candidate.end)
        ) return [];
        const start = candidate.start as number;
        const end = candidate.end as number;
        if (start < 0 || end <= start || end > text.length) return [];
        const visible = text.slice(start, end);
        const before = text.slice(Math.max(0, start - 1), start);
        const after = text.slice(end, end + 1);
        if (
            !visible.startsWith('@')
            || visible.length === 1
            || (start > 0 && !/\s/u.test(before))
            || /[\p{L}\p{N}_]/u.test(after)
        ) return [];
        return [keys === 'accountId,end,start'
            ? { start, end, accountId: identity.data }
            : keys === 'end,sessionId,start' ? { start, end, sessionId: identity.data }
                : { start, end, participantSlotId: identity.data }];
    }).sort((left, right) => left.start - right.start || left.end - right.end);

    let greatestPreviousEnd = -1;
    return candidates.filter((candidate, index) => {
        const overlapsPrevious = greatestPreviousEnd > candidate.start;
        greatestPreviousEnd = Math.max(greatestPreviousEnd, candidate.end);
        const overlapsNext = (candidates[index + 1]?.start ?? Number.POSITIVE_INFINITY) < candidate.end;
        // An ambiguous range is not resolved by array order. Every conflicting
        // entry remains plain text instead of choosing an Account identity.
        return !overlapsPrevious && !overlapsNext;
    });
}

/**
 * Keeps selected participant identity attached only while its complete visible
 * token survives an edit. This is a document transform, not cursor policy:
 * every UI host (native/web and synchronized draft replay) gets identical
 * mention behavior without trusting a freshly typed `@label` as identity.
 */
export function reconcileDiscussionMentionSpans(params: Readonly<{
    previousText: string;
    nextText: string;
    mentions: readonly DiscussionMentionSpan[];
}>): readonly DiscussionMentionSpan[] {
    const mentions = parseDiscussionMentionSpans(params.mentions, params.previousText).map((span) => ({
        ...span, tokenText: params.previousText.slice(span.start, span.end),
    }));
    const reconciled = reconcileStructuredInputMentionsWithText({ ...params, mentions });
    return parseDiscussionMentionSpans(reconciled.map(({ tokenText: _tokenText, ...span }) => span), params.nextText);
}

export function buildDiscussionContent(
    text: string,
    mentions: readonly DiscussionMentionSpan[],
): DiscussionTextMessageContentV1 {
    const parts: DiscussionTextMessageContentV1['parts'][number][] = [];
    let offset = 0;
    for (const mention of parseDiscussionMentionSpans(mentions, text)) {
        if (typeof mention.participantSlotId === 'string') throw new Error('discussion_participant_start_required');
        if (mention.start > offset) {
            parts.push({ t: 'text', text: text.slice(offset, mention.start).normalize('NFC') });
        }
        parts.push({ t: 'mention', participant: typeof mention.accountId === 'string'
            ? { kind: 'account', accountId: mention.accountId }
            : { kind: 'session', sessionId: mention.sessionId } });
        offset = mention.end;
    }
    if (offset < text.length) parts.push({ t: 'text', text: text.slice(offset).normalize('NFC') });
    return DiscussionTextMessageContentV1Schema.parse({ v: 1, parts });
}

export function buildDiscussionContentFromPendingText(input: Readonly<{
    previousText: string;
    pendingText: string;
    mentions: readonly DiscussionMentionSpan[];
}>): DiscussionTextMessageContentV1 {
    return buildDiscussionContent(input.pendingText, reconcileDiscussionMentionSpans({
        previousText: input.previousText,
        nextText: input.pendingText,
        mentions: input.mentions,
    }));
}

/**
 * An Account mention inside the one composer (`AgentInput`). It is the discussion's own reference:
 * the `accountMention` suggestion kind produces it and only this adapter reads it back, as the
 * `{ start, end, accountId }` span the draft stores and the `mention` part the wire carries.
 * Parsed reference identity is inert; only the committed post owner may admit addressing.
 */
export const DISCUSSION_ACCOUNT_MENTION_KIND = 'happier.account';
const DISCUSSION_ACCOUNT_MENTION_REF_SCHEME = 'account';
/** Inert draft identity only. Send resolves it through the current Discussion roster. */
export const DISCUSSION_MODEL_SLOT_MENTION_KIND = 'happier.discussionParticipant';
const DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME = 'discussion-participant';
export function buildDiscussionModelSlotMentionPayload(participantSlotId: string, label: string) {
    return { kind: DISCUSSION_MODEL_SLOT_MENTION_KIND,
        ref: buildMentionRefV1(DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME, participantSlotId), label };
}

/** What the `accountMention` kind hands the composer; the composer adds the token and its range. */
export function buildDiscussionAccountMentionPayload(accountId: string, label: string): Readonly<{
    kind: string;
    ref: string;
    label: string;
}> {
    return { kind: DISCUSSION_ACCOUNT_MENTION_KIND, ref: buildMentionRefV1(DISCUSSION_ACCOUNT_MENTION_REF_SCHEME, accountId), label };
}

/** The draft's spans as the composer's mentions, each bound to the visible token it covers. */
export function discussionComposerMentionsFromSpans(
    text: string,
    spans: readonly DiscussionMentionSpan[],
): ComposerStructuredInputMention[] {
    return parseDiscussionMentionSpans(spans, text).map((span) => ({
        ...(typeof span.accountId === 'string'
            ? { kind: DISCUSSION_ACCOUNT_MENTION_KIND, ref: buildMentionRefV1(DISCUSSION_ACCOUNT_MENTION_REF_SCHEME, span.accountId) }
            : typeof span.sessionId === 'string' ? { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, span.sessionId) }
                : buildDiscussionModelSlotMentionPayload(span.participantSlotId, text.slice(span.start, span.end))),
        tokenText: text.slice(span.start, span.end),
        start: span.start,
        end: span.end,
    }));
}

/**
 * The composer's Account, Session and reserved-slot references as local draft spans.
 * Other kinds remain ordinary text; only Send resolves slots to canonical Session mentions.
 * Parsing never authorizes execution.
 */
export function discussionMentionSpansFromComposerMentions(
    mentions: readonly ComposerStructuredInputMention[],
): DiscussionMentionSpan[] {
    return mentions.flatMap((mention): DiscussionMentionSpan[] => {
        if (!('ref' in mention) || typeof mention.ref !== 'string') return [];
        const range = { start: mention.start, end: mention.end };
        if (mention.kind === DISCUSSION_ACCOUNT_MENTION_KIND) {
            const ref = parseMentionRefV1(mention.ref);
            const accountId = DiscussionAccountIdSchema.safeParse(ref?.scheme === DISCUSSION_ACCOUNT_MENTION_REF_SCHEME ? ref.opaque : null);
            return accountId.success ? [{ ...range, accountId: accountId.data }] : [];
        }
        if (mention.kind === MENTION_KIND_V1.session) {
            const sessionId = SessionIdSchema.safeParse(readMentionRefOpaqueForKindV1(MENTION_KIND_V1.session, mention.ref));
            return sessionId.success ? [{ ...range, sessionId: sessionId.data }] : [];
        }
        if (mention.kind === DISCUSSION_MODEL_SLOT_MENTION_KIND) {
            const ref = parseMentionRefV1(mention.ref);
            const slot = DiscussionIdSchema.safeParse(ref?.scheme === DISCUSSION_MODEL_SLOT_MENTION_REF_SCHEME ? ref.opaque : null);
            return slot.success ? [{ ...range, participantSlotId: slot.data }] : [];
        }
        return [];
    });
}
