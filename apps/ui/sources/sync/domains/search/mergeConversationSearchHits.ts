import { isMemorySessionSearchHitV1, isMemoryExternalTranscriptSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { ConversationSearchHit, ConversationSearchResult } from './searchConversations';

function hitTime(row: ConversationSearchHit): number {
    return row.mode === 'standard' ? row.candidate.updatedAtMs
        : 'createdAtToMs' in row.hit && typeof row.hit.createdAtToMs === 'number' ? row.hit.createdAtToMs : 0;
}

function nativeConversation(row: ConversationSearchHit): Readonly<{ id: string; sourceKey: string }> | null {
    if (row.mode === 'standard') return {
        id: JSON.stringify([row.machineId, row.agentId, row.candidate.remoteSessionId]), sourceKey: row.sourceKey,
    };
    if (isMemoryExternalTranscriptSearchHitV1(row.hit)) return {
        id: JSON.stringify([row.machineId, row.hit.source.agentId, row.hit.source.nativeSessionId]), sourceKey: row.hit.source.sourceKey,
    };
    return null;
}

/** One native conversation belongs to the first configured source that returned it.
 * Keep the original row (including source/link data) for opening, and leave each
 * producer's continuation/coverage alone: its later pages may have unique hits.
 */
export function mergeConversationSearchHits(
    rows: readonly ConversationSearchHit[],
    sources: ConversationSearchResult['sources'] = [],
): ConversationSearchHit[] {
    const sourceOrder = new Map(sources.map((source, index) => [JSON.stringify([source.machineId, source.agentId, source.sourceKey]), index]));
    const owners = new Map<string, Readonly<{ sourceKey: string; order: number }>>();
    for (const row of rows) {
        const identity = nativeConversation(row);
        if (!identity) continue;
        const agentId = row.mode === 'standard' ? row.agentId
            : isMemoryExternalTranscriptSearchHitV1(row.hit) ? row.hit.source.agentId : undefined;
        const order = sourceOrder.get(JSON.stringify([row.machineId, agentId, identity.sourceKey])) ?? Number.POSITIVE_INFINITY;
        const owner = owners.get(identity.id);
        if (!owner || order < owner.order) owners.set(identity.id, { sourceKey: identity.sourceKey, order });
    }
    const sorted = [...rows].sort((a, b) => hitTime(b) - hitTime(a));
    const sessions = new Set<string>();
    const native = new Set<string>();
    return sorted.filter(row => {
        const identity = nativeConversation(row);
        if (identity && owners.get(identity.id)?.sourceKey !== identity.sourceKey) return false;
        if (row.mode === 'indexed' && isMemorySessionSearchHitV1(row.hit)) {
            const id = row.hit.sessionId.trim();
            if (!id || sessions.has(id)) return false;
            sessions.add(id);
        } else if (row.mode === 'indexed' && isMemoryExternalTranscriptSearchHitV1(row.hit)) {
            const id = JSON.stringify([row.machineId, row.hit.source.agentId, row.hit.source.sourceKey, row.hit.source.nativeSessionId, row.hit.sourceItemId]);
            if (native.has(`indexed:${id}`) || native.has(`scanned:${id}`)) return false;
            native.add(`indexed:${id}`);
        } else if (row.mode === 'standard') {
            if (row.candidate.linkedSessionId) {
                const sessionId = row.candidate.linkedSessionId.trim();
                if (sessions.has(sessionId)) return false;
                sessions.add(sessionId);
            }
            // A standard scan returns one hit per native candidate. A later
            // changed-file pass can select a different message in that candidate.
            const id = JSON.stringify([row.machineId, row.agentId, row.sourceKey,
                row.candidate.candidateKey ?? row.candidate.remoteSessionId]);
            const matchId = JSON.stringify([row.machineId, row.agentId, row.sourceKey,
                row.candidate.remoteSessionId, row.candidate.match?.sourceItemId]);
            if (native.has(`candidate:${id}`) || native.has(`indexed:${matchId}`)) return false;
            native.add(`candidate:${id}`);
            native.add(`scanned:${matchId}`);
        }
        return true;
    });
}
