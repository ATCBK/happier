import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, type ChangeEntry } from '@happier-dev/protocol/changes';
import {
    subscribeHomeCredentialMutations,
    type HomeCredentialMutationEvent,
} from '@/auth/storage/tokenStorage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/**
 * Observers of the content-free Account-change wake this owner already receives
 * on each Home socket.
 *
 * This is an observation seam over the existing wake, not a second
 * synchronization system: it opens no socket, starts no cursor, replays no
 * domain events and promises no delivery or ordering beyond the wake itself.
 * Account-scoped projections that are fully reconstructible (Home governance,
 * Teams, Follow preferences) use it to invalidate the exact Home and refetch.
 */
export type HomeAccountChangeEvent = Readonly<{
    serverId: string;
    /** Transport connection, or an early socket wake before detailed catch-up has answered. */
    source?: 'connected' | 'catch-up-pending';
    /** Exact only for a consumed focused-Home change page; absent wakes remain conservative. */
    entityIds?: readonly string[];
    /** Revision hints from the consumed change page; never inferred from a socket wake. */
    entityRevisions?: Readonly<Record<string, number>>;
    /** Present when the publisher knows the changed domains; omitted wakes remain conservative. */
    changeKinds?: readonly ChangeEntry['kind'][];
    /**
     * Detailed focused-Home catch-up may publish the incumbent change planner's
     * exact Session-list decision. Socket-only concurrent-Home wakes omit it and
     * remain conservative. `'structural'` means only row-level Session writes: a
     * corpus the ordinary list can answer is unaffected, a structural filter may move.
     */
    sessionListQueryAffects?: boolean | 'structural';
    /** Exact focused-page Profile/Artifact/source decision; content-free wakes omit it. */
    profileCatalogAffects?: boolean;
    /** Machine-only focused pages are covered by the Usage store's material-input subscription. */
    usageQueryAffects?: boolean;
    /** An acknowledged local Artifact deletion; no private content or replay guarantee. */
    deletedArtifactIds?: readonly string[];
}>;

type HomeAccountChangeDetails = Readonly<{
    entityRevisions?: Readonly<Record<string, number>>;
    source?: 'connected' | 'catch-up-pending';
    changeKinds?: readonly ChangeEntry['kind'][];
    sessionListQueryAffects?: boolean | 'structural';
    profileCatalogAffects?: boolean;
    usageQueryAffects?: boolean;
    deletedArtifactIds?: readonly string[];
}>;

/** An Artifact receipt wakes its readers, without invalidating unrelated mutable domain work. */
export function isArtifactOnlyHomeAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.changeKinds !== undefined && event.changeKinds.length > 0
        && event.changeKinds.every(kind => kind === 'artifact');
}

/** Focused changes that can alter Home administration eligibility or rows. */
export function isHomeAdministrationAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.entityIds === undefined
        || event.entityIds.includes(HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes('self');
}

type HomeAccountChangeObserver = (event: HomeAccountChangeEvent) => void;

const homeAccountChangeObservers = new Map<HomeAccountChangeObserver, boolean>();

// This fences pending raw reads only; it is not an Account cursor or a currentness fact.
const homeAccountReadRevisions = new Map<string, number>();

export function readHomeAccountReadRevision(serverId: string): number {
    return homeAccountReadRevisions.get(resolveServerProfileScopeIdForIdentifier(serverId)) ?? 0;
}

/** Forget raw read joins without asserting that a domain mutation committed. */
export function invalidateHomeAccountReadJoins(serverId: string): void {
    homeAccountReadRevisions.set(resolveServerProfileScopeIdForIdentifier(serverId), readHomeAccountReadRevision(serverId) + 1);
}

type HomeCredentialChangeObserver = (event: HomeCredentialMutationEvent) => void;
const homeCredentialChangeObservers = new Set<HomeCredentialChangeObserver>();
let unsubscribeHomeCredentialMutations: (() => void) | null = null;

function releaseHomeCredentialMutationObserverIfIdle(): void {
    if (homeCredentialChangeObservers.size > 0) return;
    unsubscribeHomeCredentialMutations?.();
    unsubscribeHomeCredentialMutations = null;
}

/**
 * One refcounted credential-mutation fanout for reconstructible Home projections. Domains decide
 * whether to retain signed-out rows or clear replaced-Account rows; none installs its own watcher.
 */
export function subscribeHomeCredentialChange(observer: HomeCredentialChangeObserver): () => void {
    homeCredentialChangeObservers.add(observer);
    if (!unsubscribeHomeCredentialMutations) {
        unsubscribeHomeCredentialMutations = subscribeHomeCredentialMutations((event) => {
            for (const current of [...homeCredentialChangeObservers]) {
                try {
                    current(event);
                } catch {
                    // One projection cannot suppress credential retirement for its siblings.
                }
            }
        });
    }
    return () => {
        homeCredentialChangeObservers.delete(observer);
        releaseHomeCredentialMutationObserverIfIdle();
    };
}

export type { HomeCredentialMutationEvent };

export function subscribeHomeAccountChange(
    observer: HomeAccountChangeObserver,
    // Most projections consume exact planned entities. Catalogs may opt into
    // early revalidation without making every observer refetch on every wake.
    options?: Readonly<{ includeCatchUpPending?: boolean }>,
): () => void {
    homeAccountChangeObservers.set(observer, options?.includeCatchUpPending === true);
    return () => {
        homeAccountChangeObservers.delete(observer);
    };
}

export function publishHomeAccountChange(
    serverId: string,
    entityIds?: readonly string[],
    details?: HomeAccountChangeDetails,
): void {
    // Advance before any consumer can synchronously start its refresh. An adapter
    // listener would depend on insertion order and could join a pre-wake read.
    invalidateHomeAccountReadJoins(serverId);
    if (homeAccountChangeObservers.size === 0) return;
    const event = Object.freeze({
        serverId,
        ...(details?.source ? { source: details.source } : {}),
        ...(entityIds ? { entityIds: Object.freeze([...new Set(entityIds)]) } : {}),
        ...(details?.entityRevisions ? { entityRevisions: Object.freeze({ ...details.entityRevisions }) } : {}),
        ...(details?.changeKinds ? { changeKinds: Object.freeze([...new Set(details.changeKinds)]) } : {}),
        ...(details?.sessionListQueryAffects !== undefined
            ? { sessionListQueryAffects: details.sessionListQueryAffects }
            : {}),
        ...(details?.profileCatalogAffects !== undefined ? { profileCatalogAffects: details.profileCatalogAffects } : {}),
        ...(details?.usageQueryAffects !== undefined ? { usageQueryAffects: details.usageQueryAffects } : {}),
        ...(details?.deletedArtifactIds ? { deletedArtifactIds: Object.freeze([...new Set(details.deletedArtifactIds)]) } : {}),
    });
    for (const [observer, includeCatchUpPending] of [...homeAccountChangeObservers]) {
        if (event.source === 'catch-up-pending' && !includeCatchUpPending) continue;
        try {
            observer(event);
        } catch {
            // One observer cannot suppress the wake for its siblings or for
            // this owner's own session-cache refresh.
        }
    }
}
