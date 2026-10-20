import { omit } from 'zod/mini';
import { DiscussionSelectionSourceV1Schema, readDiscussionMessagePartsV1, type DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';

import { formatSelectedMessagesForClipboard } from '@/components/sessions/transcript/messageSelection/formatSelectedMessagesForClipboard';
import type { TranscriptBulkCopyFormat } from '@/components/sessions/transcript/messageSelection/_types';

type SendSelectionSource = Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;

export type SelectableDiscussionMessage = DiscussionOpenedMessageV1 & Readonly<{
    authorAccountId: string;
    content: NonNullable<DiscussionOpenedMessageV1['content']>;
}>;

function renderDiscussionContent(
    message: DiscussionOpenedMessageV1,
    resolveAccountLabel: (accountId: string) => string | null,
    resolveSessionLabel?: (sessionId: string) => string | null,
): string | null {
    if (!message.content) return null;
    const parts: string[] = [];
    for (const part of readDiscussionMessagePartsV1(message.content)) {
        if (part.t === 'text') {
            parts.push(part.text);
            continue;
        }
        const label = (part.participant.kind === 'account'
            ? resolveAccountLabel(part.participant.accountId)
            : resolveSessionLabel?.(part.participant.sessionId))?.trim();
        if (!label) return null;
        parts.push(`@${label}`);
    }
    return parts.join('');
}

/**
 * The one eligibility decision for Discussion message selection: a row is
 * selectable when it carries a canonical Account author and opened content.
 *
 * Agent provenance is attribution, not exclusion — an Agent-posted row is a
 * collaborator's message the Session's Agent wrote on their behalf, and the
 * user can Copy, Ask Agent and Send to Session with it like any other row. The
 * eligible-row list, the per-row affordance and this formatter consume this
 * same predicate so one surface can never offer a row another one drops.
 */
export function isSelectableDiscussionMessage(
    message: DiscussionOpenedMessageV1,
): message is SelectableDiscussionMessage {
    return message.authorAccountId !== null && message.content !== null;
}

/**
 * Adapts opened Discussion rows to the one neutral transcript-selection formatter.
 * It neither fetches content nor invents labels, authority, queueing, or draft state.
 */
export function prepareDiscussionSelectionHandoff(params: Readonly<{
    serverId: string;
    discussionId: string;
    selectedMessageIds: readonly string[];
    messages: readonly DiscussionOpenedMessageV1[];
    resolveAccountLabel: (accountId: string) => string | null;
    resolveSessionLabel?: (sessionId: string) => string | null;
    format: TranscriptBulkCopyFormat;
    roleLabels: Readonly<{ user: string; assistant: string }>;
    /** The same `Via Agent` attribution the row renders, kept in the copied label. */
    agentAttributionLabel: string;
}>): Readonly<{ text: string; source: SendSelectionSource }> | null {
    const selected = new Set(params.selectedMessageIds);
    const entries: Array<Readonly<{ id: string; seq: number; role: 'user'; label: string; text: string }>> = [];
    for (const message of params.messages) {
        if (!selected.has(message.id) || !isSelectableDiscussionMessage(message)) continue;
        // Preserve the committed source instead of relabelling a stale row after
        // Home or Discussion navigation with the current destination's identity.
        if (message.messageRef.discussion.serverId !== params.serverId
            || message.messageRef.discussion.discussionId !== params.discussionId
            || message.discussionId !== params.discussionId) return null;
        const accountLabel = params.resolveAccountLabel(message.authorAccountId)?.trim();
        const text = renderDiscussionContent(message, params.resolveAccountLabel, params.resolveSessionLabel);
        if (!accountLabel || text === null) return null;
        const label = message.producerV1 === null
            ? accountLabel
            : `${accountLabel} · ${params.agentAttributionLabel}`;
        entries.push({ id: message.id, seq: message.seq, role: 'user', label, text });
    }
    entries.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    if (entries.length === 0) return null;

    const source = omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true }).parse({
        kind: 'discussion',
        serverId: params.serverId,
        discussionId: params.discussionId,
        messageIds: entries.map((entry) => entry.id),
    });
    return {
        text: formatSelectedMessagesForClipboard(entries, {
            format: params.format,
            roleLabels: params.roleLabels,
        }),
        source,
    };
}
