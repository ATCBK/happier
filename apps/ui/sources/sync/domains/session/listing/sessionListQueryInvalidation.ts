import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isArtifactOnlyHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type SessionListQueryInvalidationTarget = Readonly<{
    /** `'structural'` re-reads only a corpus whose server-side selection a row write can move. */
    invalidate(scope?: 'structural'): Promise<void>;
    retire(sessionId: string): void;
}>;

type SessionListQueryInvalidationReader = () => ReadonlyMap<string, SessionListQueryInvalidationTarget>;
const mountedSessionListQueryReaders = new Set<SessionListQueryInvalidationReader>();

const readEpochByServerId = new Map<string, number>();
const invalidationsCounted = new WeakSet<object>();

function advanceReadEpoch(serverId: string): void {
    readEpochByServerId.set(serverId, (readEpochByServerId.get(serverId) ?? 0) + 1);
}

/**
 * Which generation of a Home's corpus a page read belongs to. Every invalidation of the Home starts a
 * new one, so a read already on the wire when a Home changed cannot answer a read asked for afterwards.
 */
export function readSessionListQueryReadEpoch(serverId: string): number {
    return readEpochByServerId.get(serverId) ?? 0;
}

/**
 * Invalidates the mounted filtered-list controller for one exact Home.
 *
 * This is the imperative leaf of the existing query-invalidation owner. It is
 * used when a local wall-clock boundary changes list membership without a Home
 * Account-change event (for example a persisted reminder becoming due).
 */
export function invalidateSessionListQueryHome(serverId: string): Promise<void> {
    advanceReadEpoch(serverId);
    const pending: Array<Promise<void>> = [];
    for (const readControllers of mountedSessionListQueryReaders) {
        const target = readControllers().get(serverId);
        if (target) pending.push(target.invalidate());
    }
    return Promise.all(pending).then(() => undefined);
}

/**
 * Retires one committed-deleted/revoked Session from the mounted filtered-list
 * membership of exactly that Home (every Home when the retirement addressed none),
 * leaving a same-id Session on another Home untouched.
 */
export function retireSessionListQueryAddress(serverId: string | null, sessionId: string): void {
    for (const readControllers of mountedSessionListQueryReaders) {
        for (const [controllerServerId, target] of readControllers()) {
            if (serverId && !areServerProfileIdentifiersEquivalent(controllerServerId, serverId)) continue;
            target.retire(sessionId);
        }
    }
}

/**
 * Exact focused-Home catch-up identifies `self` for Account settings, profile,
 * security and encryption changes. The incumbent planner supplies whether the
 * concrete change can alter qualified list membership; this consumer must not
 * guess from the shared `self` identifier.
 *
 * A socket-only concurrent-Home wake has no entity identities, so it stays
 * conservative. Do not infer a domain cause from content or ciphertext here.
 */
export function resolveSessionListQueryInvalidationForAccountChange(
    event: HomeAccountChangeEvent,
): 'none' | 'structural' | 'all' {
    if (event.sessionListQueryAffects !== undefined) {
        if (event.sessionListQueryAffects === 'structural') return 'structural';
        return event.sessionListQueryAffects ? 'all' : 'none';
    }
    // Committed Artifact receipts also wake Account readers, but cannot move
    // a Session corpus. Mixed or unqualified wakes keep the conservative path.
    if (isArtifactOnlyHomeAccountChange(event)) return 'none';
    return event.entityIds === undefined
        || event.entityIds.some((entityId) => entityId !== 'self')
        ? 'all'
        : 'none';
}

/**
 * Connect mounted filtered-list controllers to the incumbent Account-change
 * owner. This adapter requests one exact-Home refresh; it does not interpret
 * membership or create another event stream.
 */
export function subscribeSessionListQueryHomeInvalidation(
    readControllers: SessionListQueryInvalidationReader,
): () => void {
    mountedSessionListQueryReaders.add(readControllers);
    const unsubscribeAccountChanges = subscribeHomeAccountChange((event) => {
        const invalidation = resolveSessionListQueryInvalidationForAccountChange(event);
        if (invalidation === 'none') return;
        // Each mounted corpus hears the same event; the Home's reads start a new generation once.
        if (!invalidationsCounted.has(event)) {
            invalidationsCounted.add(event);
            advanceReadEpoch(event.serverId);
        }
        const target = readControllers().get(event.serverId);
        if (!target) return;
        void (invalidation === 'structural' ? target.invalidate('structural') : target.invalidate());
    });
    return () => {
        unsubscribeAccountChanges();
        mountedSessionListQueryReaders.delete(readControllers);
    };
}
