import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { readHomeAccountReadRevision } from '@/sync/runtime/orchestration/homeAccountChange';
import { sync } from '@/sync/sync';
import {
    fetchConcurrentSessionListQueryPage,
    getConcurrentSessionListQueryHomeAvailability,
    isConcurrentOrdinarySessionListHome,
    loadNextConcurrentOrdinarySessionListPage,
    readConcurrentOrdinarySessionListLifecycle,
    refreshConcurrentOrdinarySessionList,
    retryConcurrentSessionListQueryHome,
} from '@/sync/runtime/orchestration/concurrentSessionCache';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    retryActiveServerConnection,
} from '@/sync/runtime/orchestration/connectionManager';

import { buildOrdinarySessionListHomeState, type OrdinarySessionListLifecycle } from './ordinarySessionListHomeState';
import { readSessionListQueryReadEpoch } from './sessionListQueryInvalidation';
import type {
    SessionListQueryHomeState,
    SessionListQueryPageRequest,
} from './sessionListQueryController';

export type SessionListQueryHomeAvailability = 'online' | 'pending' | 'offline';

export function getSessionListQueryHomeAvailability(
    serverIdRaw: string,
): SessionListQueryHomeAvailability {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return 'offline';
    const staged = getActiveServerSnapshot();
    const applied = getAppliedActiveServerSnapshot();
    const runtimeAvailable = isAppliedActiveServerRuntimeAvailable();
    const isApplied = areServerProfileIdentifiersEquivalent(serverId, applied.serverId);
    const hasUnappliedStagedHome = !areServerProfileIdentifiersEquivalent(staged.serverId, applied.serverId);

    // The staged target is withdrawn from the secondary cache before it can own the singleton.
    // That ownership gap is loading, not evidence that the Home is unreachable.
    if (
        hasUnappliedStagedHome
        && areServerProfileIdentifiersEquivalent(serverId, staged.serverId)
    ) {
        return 'pending';
    }
    if (runtimeAvailable && isApplied) {
        return storage.getState().socketStatus === 'connected' ? 'online' : 'offline';
    }
    const concurrentAvailability = getConcurrentSessionListQueryHomeAvailability(serverId);
    if (concurrentAvailability !== 'offline') return concurrentAvailability;
    return 'offline';
}

export function isSessionListQueryHomeOnline(serverIdRaw: string): boolean {
    return getSessionListQueryHomeAvailability(serverIdRaw) === 'online';
}

/**
 * Reads the incumbent ordinary lifecycle without creating a second pagination owner.
 */
export function readOrdinarySessionListLifecycle(serverId: string): OrdinarySessionListLifecycle {
    return resolveOrdinarySessionListHomeOwner(serverId) === 'sync'
        ? sync.readOrdinarySessionListLifecycle()
        : readConcurrentOrdinarySessionListLifecycle(serverId);
}

/**
 * Whether Sync's singleton lifecycle owns this Home's ordinary `/v2/sessions`
 * corpus. It is the same fact that routes a page request to Sync rather than to
 * the concurrent cache, so the filter's ordinary corpus cannot disagree with the
 * transport about which Home Sync is serving.
 */
export function isSyncOwnedOrdinarySessionListHome(serverIdRaw: string): boolean {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return false;
    return isAppliedActiveServerRuntimeAvailable()
        && areServerProfileIdentifiersEquivalent(serverId, getAppliedActiveServerSnapshot().serverId);
}

export type OrdinarySessionListHomeOwner = 'sync' | 'concurrent';

/**
 * Which runtime owns this Home's ordinary `/v2/sessions` corpus, if any.
 *
 * One answer for every Home: Sync owns the applied active Home, the concurrent
 * cache owns every other managed Home. A filter whose corpus is ordinary reads
 * the incumbent frontier through this seam rather than mounting a controller
 * that would paginate and `replace` the same membership behind a second cursor.
 */
export function resolveOrdinarySessionListHomeOwner(
    serverIdRaw: string,
): OrdinarySessionListHomeOwner | null {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return null;
    if (isSyncOwnedOrdinarySessionListHome(serverId)) return 'sync';
    return isConcurrentOrdinarySessionListHome(serverId) ? 'concurrent' : null;
}

/**
 * The incumbent ordinary frontier for this Home, projected onto the per-Home query
 * state, so one cursor advances and one membership is canonical.
 */
export function readOrdinarySessionListHomeState(input: Readonly<{
    serverId: string;
    requestedQueryKey: string;
    online: boolean | null;
}>): SessionListQueryHomeState {
    const state = storage.getState();
    return buildOrdinarySessionListHomeState({
        serverId: input.serverId,
        requestedQueryKey: input.requestedQueryKey,
        sessionIds: state.ordinarySessionListMembershipByServerId?.[input.serverId] ?? [],
        observation: state.concurrentSessionListCacheByServerId?.[input.serverId]?.listObservation ?? null,
        lifecycle: readOrdinarySessionListLifecycle(input.serverId),
        online: input.online,
    });
}

/** Advance this Home's incumbent ordinary frontier. There is no second cursor to advance. */
export async function loadNextOrdinarySessionListPage(serverIdRaw: string): Promise<void> {
    if (resolveOrdinarySessionListHomeOwner(serverIdRaw) === 'sync') {
        await sync.fetchMoreSessions();
        return;
    }
    await loadNextConcurrentOrdinarySessionListPage(serverIdRaw);
}

/** Replace this Home's ordinary corpus from page one. */
export async function refreshOrdinarySessionList(serverIdRaw: string): Promise<void> {
    if (resolveOrdinarySessionListHomeOwner(serverIdRaw) === 'sync') {
        await sync.refreshSessions();
        return;
    }
    await refreshConcurrentOrdinarySessionList(serverIdRaw);
}

/**
 * Page reads on the wire. Every surface that shows a corpus owns its own controller, so one commit
 * that mounts several of them, or one Account change that refreshes them, asks for the same page
 * together. Those callers share one request. A read that began before the Home's latest invalidation
 * is never shared with a caller that asks after it.
 */
const pageReads = createScopedResolutionSingleFlight<Awaited<ReturnType<typeof readSessionListQueryPageForHome>>>();

/**
 * A strict-query page and a row-only page of one corpus are the same read: the store tells them apart
 * only by whether the page may bootstrap an ordinary list index, which the ordinary owner establishes itself.
 */
function readSharedMembership(membership: SessionListQueryPageRequest['membership']): string {
    return membership === 'query' || membership === 'rowOnly' ? 'corpus' : membership;
}

/** One request per concurrent corpus read; it is aborted only when every caller that wanted it has left. */
export function fetchSessionListQueryPageForHome(
    serverIdRaw: string,
    page: SessionListQueryPageRequest,
) {
    const serverId = String(serverIdRaw ?? '').trim();
    const key = JSON.stringify([
        serverId, readHomeAccountReadRevision(serverId), readSessionListQueryReadEpoch(serverId),
        page.source, readSharedMembership(page.membership), page.hydration ?? null, page.limit ?? null, page.cursor ?? null, page.attentionCursor ?? null,
    ]);
    return pageReads.run(key, signal => readSessionListQueryPageForHome(serverId, { ...page, signal }), { signal: page.signal });
}

async function readSessionListQueryPageForHome(
    serverId: string,
    page: SessionListQueryPageRequest,
) {
    if (isSyncOwnedOrdinarySessionListHome(serverId)) {
        return sync.fetchSessionListQueryPage(serverId, page);
    }
    return fetchConcurrentSessionListQueryPage(serverId, page);
}

/**
 * The query source owns controller refresh; this boundary only restores the
 * exact Home transport that made its query unavailable.
 */
export async function retrySessionListQueryHome(serverIdRaw: string): Promise<void> {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return;
    if (isSyncOwnedOrdinarySessionListHome(serverId)) {
        await retryActiveServerConnection();
        return;
    }
    await retryConcurrentSessionListQueryHome(serverId);
}
