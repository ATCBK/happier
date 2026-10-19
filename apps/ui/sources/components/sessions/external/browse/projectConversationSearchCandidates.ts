import { isMemoryExternalTranscriptSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import { createExternalSessionContentMatchSnippet } from '@happier-dev/protocol/sessions/external/contentSearchMatch';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import type { ConversationSearchHit } from '@/sync/domains/search/searchConversations';
import type { ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';

/** Shared native identity adaptation for History and the activated scan surface. */
export function projectConversationSearchCandidates(
    hits: readonly ConversationSearchHit[],
    scope: Readonly<{ machineId: string; agentId: string; sourceKey: string }>,
    query?: string,
): ExternalSessionBrowseCandidate[] {
    return hits.flatMap<ExternalSessionBrowseCandidate>(row => {
        if (row.machineId !== scope.machineId) return [];
        if (row.mode === 'standard') {
            if (row.sourceKey !== scope.sourceKey || row.agentId !== scope.agentId) return [];
            const candidate = row.candidate;
            const title = candidate.title ? readSessionInputPromptUserTextV1(candidate.title).replace(/\s+/g, ' ').trim() : undefined;
            const snippet = candidate.match && query ? createExternalSessionContentMatchSnippet(candidate.match.snippet, query) : null;
            return [{ ...candidate, title: title || undefined, searchMode: 'standard',
                ...(candidate.cwd ? { details: { ...candidate.details, cwd: candidate.cwd } } : {}),
                ...(snippet && candidate.match ? { match: { ...candidate.match, snippet } } : {}) }];
        }
        if (!isMemoryExternalTranscriptSearchHitV1(row.hit) || row.hit.source.sourceKey !== scope.sourceKey
            || row.hit.source.agentId !== scope.agentId) return [];
        return [{ remoteSessionId: row.hit.source.nativeSessionId, updatedAtMs: row.hit.createdAtToMs,
            candidateKey: JSON.stringify([row.machineId, row.hit.source.agentId, row.hit.source.sourceKey, row.hit.source.nativeSessionId, row.hit.sourceItemId]),
            searchMode: 'indexed', match: { snippet: (query ? createExternalSessionContentMatchSnippet(row.hit.summary, query) : null)
                ?? readSessionInputPromptUserTextV1(row.hit.summary), sourceItemId: row.hit.sourceItemId } }];
    });
}
