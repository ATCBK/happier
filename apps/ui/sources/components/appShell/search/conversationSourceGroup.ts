import { projectConversationSearchCandidates } from '@/components/sessions/external/browse/projectConversationSearchCandidates';
import type { ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import type { ConversationSearchResult, ConversationSearchSource } from '@/sync/domains/search/searchConversations';

type GroupSource = ConversationSearchSource & Readonly<{ machineId: string }>;

/** What one source contributes to History: its hit rows, and the cursor that pages it. */
export function readConversationSourceGroup(
    result: ConversationSearchResult | null,
    source: GroupSource,
    query: string,
): Readonly<{
    candidates: ExternalSessionBrowseCandidate[];
    continuation: NonNullable<ConversationSearchResult['continuations']>[number] | undefined;
}> {
    return {
        candidates: projectConversationSearchCandidates(result?.hits ?? [], source, query),
        continuation: result?.continuations?.find(value => value.machineId === source.machineId
            && (value.sourceKey === undefined || value.sourceKey === source.sourceKey)),
    };
}

/**
 * Sources with rows come first, in their incoming order; a source with only a next page (or no group at
 * all) follows. A row-less source line drawn above another source's hits would read as that source's heading.
 */
export function orderConversationSourceGroups<Source extends GroupSource>(
    result: ConversationSearchResult | null,
    sources: readonly Source[],
    query: string,
): Source[] {
    const withRows: Source[] = [];
    const withoutRows: Source[] = [];
    for (const source of sources) {
        (readConversationSourceGroup(result, source, query).candidates.length > 0 ? withRows : withoutRows).push(source);
    }
    return [...withRows, ...withoutRows];
}

/** A source draws a group only with rows or a next page; one with nothing to show draws nothing. */
export function conversationSourceHasGroup(
    result: ConversationSearchResult | null,
    source: GroupSource,
    query: string,
): boolean {
    const { candidates, continuation } = readConversationSourceGroup(result, source, query);
    return candidates.length > 0 || continuation?.cursor !== undefined;
}
