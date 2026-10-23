import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type HomeSettingsSnapshot = Readonly<{
    scope: ServerAccountScope;
    settings: HomeSettingsProjectionV1 | null;
    loading: boolean;
    failure: HomeActionFailure | null;
    stale: boolean;
}>;

const snapshots = new Map<string, HomeSettingsSnapshot>();
const listeners = new Set<() => void>();
const adoptionListeners = new Map<string, Set<() => void>>();

export function getHomeSettingsSnapshot(scope: ServerAccountScope): HomeSettingsSnapshot | null {
    return snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null;
}

export function subscribeHomeSettingsSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function publish(snapshot: HomeSettingsSnapshot): HomeSettingsSnapshot {
    Object.freeze(snapshot);
    snapshots.set(serverAccountScopeKeySuffix(snapshot.scope), snapshot);
    for (const listener of [...listeners]) listener();
    return snapshot;
}

export function beginHomeSettingsLoad(scope: ServerAccountScope): HomeSettingsSnapshot {
    const previous = getHomeSettingsSnapshot(scope);
    return publish({ scope, settings: previous?.settings ?? null, loading: true, failure: null, stale: previous?.stale ?? false });
}

export function applyHomeSettingsProjection(scope: ServerAccountScope, settings: HomeSettingsProjectionV1, current = true): void {
    publish({ scope, settings, loading: false, failure: null, stale: !current });
}

/** Accepted writes refresh only the companion reads currently demanded on this exact scope. */
export function adoptHomeSettingsProjection(scope: ServerAccountScope, settings: HomeSettingsProjectionV1): void {
    applyHomeSettingsProjection(scope, settings);
    for (const listener of [...adoptionListeners.get(serverAccountScopeKeySuffix(scope)) ?? []]) listener();
}

export function subscribeHomeSettingsAdoptions(scope: ServerAccountScope, listener: () => void): () => void {
    const key = serverAccountScopeKeySuffix(scope);
    const scoped = adoptionListeners.get(key) ?? new Set<() => void>();
    adoptionListeners.set(key, scoped);
    scoped.add(listener);
    return () => {
        scoped.delete(listener);
        if (scoped.size === 0) adoptionListeners.delete(key);
    };
}

/** Credentials no longer admit the old projection, including an in-flight reader's publication. */
export function retireHomeSettingsSnapshot(scope: ServerAccountScope): void {
    if (!snapshots.delete(serverAccountScopeKeySuffix(scope))) return;
    for (const listener of [...listeners]) listener();
}

export function applyHomeSettingsFailure(scope: ServerAccountScope, failure: HomeActionFailure): void {
    const previous = getHomeSettingsSnapshot(scope);
    const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(failure.kind);
    publish({ scope, settings: withdrawn ? null : previous?.settings ?? null, loading: false, failure, stale: !withdrawn });
}

export function invalidateHomeSettingsSnapshot(scope: ServerAccountScope): void {
    const current = getHomeSettingsSnapshot(scope);
    if (current && !current.stale) publish({ ...current, stale: true });
}

export function invalidateHomeSettingsSnapshotsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) {
        if (snapshot.scope.serverId === serverId) invalidateHomeSettingsSnapshot(snapshot.scope);
    }
}

export function resetHomeSettingsSnapshotsForTests(): void {
    snapshots.clear();
    listeners.clear();
    adoptionListeners.clear();
}
