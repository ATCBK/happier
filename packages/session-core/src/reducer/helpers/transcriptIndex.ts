import type {ReducerMessage, ReducerState} from '../reducer.js';
import {normalizeTranscriptSeq} from '../../messages/transcriptOrdering.js';

type IndexedRow = {message: ReducerMessage; realID: string | null; localId: string | null; ordinal: number};
export type TranscriptMetadataIndex = {
    byId: Map<string, Set<ReducerMessage>>;
    byLocalId: Map<string, Set<ReducerMessage>>;
    sidechainByMessageId: Map<string, string>;
    rows: Map<string, IndexedRow>;
    lastMainMessageId: string | null;
    completedRequestHistoryStartAt: number | null;
};

function remove(map: Map<string, Set<ReducerMessage>>, key: string | null, message: ReducerMessage) {
    if (!key) return;
    const rows = map.get(key);
    rows?.delete(message);
    if (rows?.size === 0) map.delete(key);
}

function add(map: Map<string, Set<ReducerMessage>>, key: string | null, message: ReducerMessage) {
    if (!key) return;
    let rows = map.get(key);
    if (!rows) map.set(key, rows = new Set());
    rows.add(message);
}

/** Rows are append/upsert-only. Ordering coordinates may be filled or advanced,
 * never removed; retain the same seq/time/insertion-order tie break as Map traversal. */
export function indexTranscriptRow(index: TranscriptMetadataIndex, message: ReducerMessage): void {
    const previous = index.rows.get(message.id);
    if (previous?.message !== message || previous.realID !== message.realID || previous.localId !== message.localId) {
        if (previous) {
            remove(index.byId, previous.realID, previous.message);
            remove(index.byLocalId, previous.localId, previous.message);
        }
        add(index.byId, message.realID, message);
        add(index.byLocalId, message.localId, message);
        index.rows.set(message.id, {message, realID: message.realID, localId: message.localId,
            ordinal: previous?.ordinal ?? index.rows.size});
    }
    if (index.sidechainByMessageId.has(message.id)) return;
    const seq = normalizeTranscriptSeq(message.seq);
    if ((seq !== null || message.realID !== null) && Number.isFinite(message.createdAt)) {
        index.completedRequestHistoryStartAt = Math.min(index.completedRequestHistoryStartAt ?? message.createdAt, message.createdAt);
    }
    const last = index.lastMainMessageId ? index.rows.get(index.lastMainMessageId) : undefined;
    const lastSeq = normalizeTranscriptSeq(last?.message.seq);
    const later = !last || (seq !== null && lastSeq === null)
        || (seq !== null && lastSeq !== null && seq > lastSeq)
        || (seq === lastSeq && (message.createdAt > last.message.createdAt
            || (message.createdAt === last.message.createdAt && index.rows.get(message.id)!.ordinal >= last.ordinal)));
    if (later) index.lastMainMessageId = message.id;
}

/** Hydrated/legacy reducers pay one census. Ordinary applies update only changed rows. */
export function readTranscriptIndex(state: ReducerState): TranscriptMetadataIndex {
    if (state.transcriptMetadataIndex) return state.transcriptMetadataIndex;
    const index: TranscriptMetadataIndex = {byId: new Map(), byLocalId: new Map(), sidechainByMessageId: new Map(),
        rows: new Map(), lastMainMessageId: null, completedRequestHistoryStartAt: null};
    for (const [sidechainId, chain] of state.sidechains) {
        for (const row of chain) index.sidechainByMessageId.set(row.id, sidechainId);
    }
    for (const row of state.messages.values()) indexTranscriptRow(index, row);
    for (const chain of state.sidechains.values()) {
        for (const row of chain) indexTranscriptRow(index, row);
    }
    state.transcriptMetadataIndex = index;
    return index;
}
