import { createReducer, reducer } from '../reducer/reducer.js';
import { normalizeRawMessages } from '../raw/normalize.js';
import { isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1, resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import { SessionForkVisualOriginV1Schema } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { getSessionTranscriptSurfaceItemReferenceSourceKeyV1, readSessionTranscriptSurfaceItemReferencesV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import type { SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

export type PublishedSessionVisualMessage = Readonly<{
    id: string; publishedSessionId: string; seq: number; localId: string | null; createdAt: number; raw: unknown;
    reference: unknown; messageRole?: SessionMessageRole; visualReadable: boolean;
}>;
export type PublishedSessionVisualProjection = { status: 'available'; referenceIndex: number }
    | { status: 'not_copied'; sourceKey: string };

/** Exact admitted associations and completed native acknowledgements share one replay owner. */
export function readPublishedSessionVisualMessages(messages: readonly PublishedSessionVisualMessage[]): ReadonlyMap<string, readonly PublishedSessionVisualProjection[]> {
    if (!messages.some(message => (message.reference && message.visualReadable)
        || (typeof message.raw === 'object' && message.raw !== null && 'meta' in message.raw))) return new Map();
    const ordered = [...messages].sort((left, right) => left.seq - right.seq);
    const normalized = normalizeRawMessages(ordered.map(message => ({ id: message.id, localId: message.localId,
        seq: message.seq, createdAt: message.createdAt, raw: message.raw, messageRole: message.messageRole })));
    const completed = reducer(createReducer(), normalized, null).messages;
    const publishedById = new Map(ordered.map(message => [message.id, message]));
    const toolsByCallId = new Map(completed.flatMap(message => message.kind === 'tool-call'
        && message.tool.state === 'completed' && message.tool.id ? [[message.tool.id, message.tool] as const] : []));
    const visible = new Map<string, PublishedSessionVisualProjection[]>();
    for (const message of normalized) {
        if (message.role !== 'agent') continue;
        const published = publishedById.get(message.id);
        if (!published) continue;
        const references = readSessionTranscriptSurfaceItemReferencesV1(published.reference) ?? [];
        const origin = SessionForkVisualOriginV1Schema.safeParse(message.meta?.forkVisualOriginV1);
        for (const content of message.content) {
            if (content.type !== 'tool-result' || content.is_error) continue;
            const tool = toolsByCallId.get(content.tool_use_id);
            if (!tool) continue;
            const candidates = references.map((reference, referenceIndex) => ({ reference, referenceIndex }));
            const selected = candidates.find(candidate => {
                const acknowledged = resolveTranscriptSessionBoardItemReferenceV1({ toolName: tool.name, state: tool.state,
                    input: tool.input, result: content.content, address: candidate.reference.sourceAddress });
                return acknowledged && isPublishedTranscriptSessionBoardItemReferenceCorrespondingV1({
                    acknowledgedReference: acknowledged, publishedReference: candidate.reference,
                    publishedSessionId: published.publishedSessionId,
                });
            });
            let projection: PublishedSessionVisualProjection | null = selected && published.visualReadable
                ? { status: 'available', referenceIndex: selected.referenceIndex } : null;
            if (!selected && origin.success && references.every(reference => 'sourceItemId' in reference)) {
                const acknowledged = resolveTranscriptSessionBoardItemReferenceV1({ toolName: tool.name, state: tool.state,
                    input: tool.input, result: content.content, address: origin.data });
                if (acknowledged) projection = { status: 'not_copied', sourceKey: getSessionTranscriptSurfaceItemReferenceSourceKeyV1({
                    sourceAddress: acknowledged.address, sourceItemId: acknowledged.itemId, sourceItemRevision: acknowledged.itemRevision,
                }) };
            }
            if (projection) {
                const entries = visible.get(published.id) ?? [];
                entries.push(projection);
                visible.set(published.id, entries);
            }
        }
    }
    return visible;
}
