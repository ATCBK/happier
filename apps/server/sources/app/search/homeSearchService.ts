import { MemorySearchQueryV1Schema, type MemorySearchQueryV1, type MemorySearchResultV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { SessionTranscriptPublicationConstraint } from '@/app/session/sessionTranscriptPublicationPolicy';
import { isPlainHomeStoragePolicy, resolveHomeSearchCapability } from './homeSearchCapability';
import type { HomeSearchDb } from './homeSearchDb';

export type HomeSearchRequestContext = Readonly<{
    visibleSessions?: readonly SessionTranscriptPublicationConstraint[];
}>;

export type HomeSearchService = Readonly<{
    capability(): ReturnType<typeof resolveHomeSearchCapability>;
    search(query: MemorySearchQueryV1, context?: HomeSearchRequestContext): MemorySearchResultV1;
}>;

/**
 * Serves Home search from the shared derived index database. The database is owned by
 * the Home search lifecycle; a `null` database degrades to a typed unavailable result
 * instead of failing, because the index is derived and rebuildable.
 */
export function createHomeSearchService(params: Readonly<{
    db: HomeSearchDb | null;
    homeServerIdentityId: string;
    storagePolicy: string;
    /** Reports whether the initial index reconciliation has completed; ready only when true. */
    isReady?: () => boolean;
    onFailure?: (error: unknown) => void;
}>): HomeSearchService {
    const capability = () => resolveHomeSearchCapability({
        indexReady: isPlainHomeStoragePolicy(params.storagePolicy) && params.db !== null,
        indexing: isPlainHomeStoragePolicy(params.storagePolicy)
            && (params.isReady ? !params.isReady() : false),
    });

    return {
        capability,
        search(query, context) {
            const parsed = MemorySearchQueryV1Schema.safeParse(query);
            if (!parsed.success) {
                return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Invalid Home search query' };
            }
            const currentCapability = capability();
            if (!currentCapability.enabled || !params.db) {
                if (!isPlainHomeStoragePolicy(params.storagePolicy)) {
                    return {
                        v: 1,
                        ok: false,
                        errorCode: 'memory_disabled',
                        error: 'Personal Home search is unavailable for encrypted content',
                    };
                }
                return {
                    v: 1,
                    ok: false,
                    errorCode: 'memory_index_missing',
                    error: currentCapability.reason === 'indexing'
                        ? 'Personal Home search is still indexing'
                        : 'Personal Home search index is unavailable',
                };
            }
            const db = params.db;
            try {
                const eligibleSessionIdSet = parsed.data.eligibleSessionIds === undefined
                    ? undefined
                    : new Set(parsed.data.eligibleSessionIds);
                if (context?.visibleSessions && parsed.data.scope.type === 'session'
                    && !context.visibleSessions.some((constraint) => constraint.sessionId === parsed.data.scope.sessionId)) {
                    return { v: 1, ok: true, hits: [] };
                }
                if (
                    eligibleSessionIdSet
                    && parsed.data.scope.type === 'session'
                    && !eligibleSessionIdSet.has(parsed.data.scope.sessionId)
                ) {
                    return { v: 1, ok: true, hits: [] };
                }
                const scopedConstraints = parsed.data.scope.type === 'session'
                    ? context?.visibleSessions
                        ? context.visibleSessions.filter((constraint) => constraint.sessionId === parsed.data.scope.sessionId)
                        : undefined
                    : context?.visibleSessions
                        ?? (eligibleSessionIdSet
                            ? [...eligibleSessionIdSet].map((sessionId) => ({ sessionId, maximumSeq: null }))
                            : undefined);
                const searchableConstraints = scopedConstraints === undefined
                    ? undefined
                    : eligibleSessionIdSet === undefined
                        ? scopedConstraints
                        : scopedConstraints.filter((constraint) => eligibleSessionIdSet.has(constraint.sessionId));
                const hits = db.search({
                    query: parsed.data.query,
                    sessionId: searchableConstraints === undefined && parsed.data.scope.type === 'session'
                        ? parsed.data.scope.sessionId
                        : undefined,
                    sessionConstraints: searchableConstraints,
                    maxResults: parsed.data.maxResults,
                });
                const minScore = parsed.data.minScore ?? 0;
                return {
                    v: 1,
                    ok: true,
                    hits: hits.filter((hit) => hit.score >= minScore).map((hit) => ({
                        sessionId: hit.sessionId,
                        seqFrom: hit.seqFrom,
                        seqTo: hit.seqTo,
                        createdAtFromMs: hit.createdAtFromMs,
                        createdAtToMs: hit.createdAtToMs,
                        summary: hit.snippet || hit.text,
                        score: hit.score,
                        homeServerIdentityId: params.homeServerIdentityId,
                        role: hit.role,
                    })),
                };
            } catch (error) {
                params.onFailure?.(error);
                return {
                    v: 1,
                    ok: false,
                    errorCode: 'memory_failed',
                    error: error instanceof Error ? error.message : 'Personal Home search failed',
                };
            }
        },
    };
}
