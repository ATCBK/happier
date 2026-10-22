import type { Message } from "../messages/messageTypes.js";
import { compareTranscriptMessagesOldestFirst, hasTranscriptMessageOrderChanged } from "../messages/transcriptOrdering.js";
import {patchMessageRecord} from './messageRecord.js';

export type OrderedTranscript = {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
};

function mergeSortedMessageIdsOldestFirst(
    existingSortedIds: readonly string[],
    insertSortedIds: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let i = 0;
    let j = 0;
    const compare = (aId: string, bId: string): number => {
        if (aId === bId) return 0;
        const a = messagesById[aId];
        const b = messagesById[bId];
        if (!a && !b) return String(aId).localeCompare(String(bId));
        if (!a) return -1;
        if (!b) return 1;
        return compareTranscriptMessagesOldestFirst(a, b);
    };
    while (i < existingSortedIds.length || j < insertSortedIds.length) {
        const aId = existingSortedIds[i];
        const bId = insertSortedIds[j];
        const nextId = aId === undefined ? bId! : bId === undefined ? aId
            : compare(aId, bId) <= 0 ? aId : bId;
        if (!seen.has(nextId)) {
            out.push(nextId);
            seen.add(nextId);
        }
        if (nextId === aId) i += 1;
        if (nextId === bId) j += 1;
    }
    return out;
}

/**
 * Apply reducer output without changing any previously published transcript.
 * Unchanged Message objects and unchanged order keep their references.
 */
export function applyReducedMessages<T extends OrderedTranscript>(prev: T, changed: readonly Message[]): T {
    const idsToRemove = new Set<string>();
    const idsToInsert: string[] = [];
    const messagesById = patchMessageRecord(prev.messagesById, changed);
    if (messagesById === prev.messagesById) return prev;
    for (const message of changed) {
        const previous = prev.messagesById[message.id];
        if (previous === message) continue;
        if (!previous) {
            idsToInsert.push(message.id);
        } else if (hasTranscriptMessageOrderChanged(previous, message)) {
            idsToRemove.add(message.id);
            idsToInsert.push(message.id);
        }
    }
    if (idsToInsert.length === 0) return { ...prev, messagesById };

    const uniqueInsertIds = Array.from(new Set(idsToInsert));
    uniqueInsertIds.sort((a, b) => compareTranscriptMessagesOldestFirst(messagesById[a]!, messagesById[b]!));
    const existingIds = prev.messageIdsOldestFirst;
    const last = existingIds[existingIds.length - 1];
    const first = uniqueInsertIds[0];
    const appendOnly = idsToRemove.size === 0 && (
        existingIds.length === 0
        || (last !== undefined && first !== undefined
            && messagesById[last] !== undefined && messagesById[first] !== undefined
            && compareTranscriptMessagesOldestFirst(messagesById[last]!, messagesById[first]!) <= 0)
    );
    const nextIds = appendOnly
        ? [...existingIds, ...uniqueInsertIds]
        : mergeSortedMessageIdsOldestFirst(
            idsToRemove.size > 0 ? existingIds.filter((id) => !idsToRemove.has(id)) : existingIds,
            uniqueInsertIds,
            messagesById,
        );
    return { ...prev, messagesById, messageIdsOldestFirst: nextIds };
}
