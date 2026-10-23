import type { HomeGovernanceEligibilityV1 } from '@happier-dev/protocol/home/governance';
import { snapshotReferenceSelectionKey } from '@/sync/domains/scope/snapshotReferenceSelectionKey';

import {
    isAuthoritativeScopedSnapshotRefusal,
    reachabilityForScopedSnapshotError,
    type ScopedSnapshotError,
    type ScopedSnapshotReachability,
    type ScopedSnapshotStatus,
} from '@/sync/domains/scope/scopedSnapshotFacts';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

export type HomeGovernanceEligibilitySnapshot = Readonly<{
    scope: ServerAccountScope;
    status: ScopedSnapshotStatus;
    /** Last successful minimum projection, retained while a refresh is pending or offline. */
    data: HomeGovernanceEligibilityV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

const snapshots = new Map<string, HomeGovernanceEligibilitySnapshot>();
const listeners = new Set<() => void>();

function keyOf(scope: ServerAccountScope): string {
    return serverAccountScopeKeySuffix(scope);
}

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // One surface cannot stop its siblings from observing eligibility.
        }
    }
}

function write(scope: ServerAccountScope, snapshot: HomeGovernanceEligibilitySnapshot): void {
    snapshots.set(keyOf(scope), snapshot);
    notify();
}

/** Only the requested exact Home/Account snapshots contribute to React selection identity. */
export function getHomeGovernanceEligibilitySnapshotsSelectionKey(scopes: readonly ServerAccountScope[]): string {
    return snapshotReferenceSelectionKey(scopes.map(getHomeGovernanceEligibilitySnapshot));
}

export function subscribeHomeGovernanceEligibilitySnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getHomeGovernanceEligibilitySnapshot(
    scope: ServerAccountScope | null | undefined,
): HomeGovernanceEligibilitySnapshot | null {
    return scope ? snapshots.get(keyOf(scope)) ?? null : null;
}

export function beginHomeGovernanceEligibilityLoad(scope: ServerAccountScope): void {
    const current = getHomeGovernanceEligibilitySnapshot(scope);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current?.status === status && current.error === null) return;
    write(scope, Object.freeze({
        scope,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
}

export function applyHomeGovernanceEligibility(params: Readonly<{
    scope: ServerAccountScope;
    eligibility: HomeGovernanceEligibilityV1;
    observedAt: number;
    current?: boolean;
}>): void {
    write(params.scope, Object.freeze({
        scope: params.scope,
        status: 'ready',
        data: params.eligibility,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
}

export function invalidateHomeGovernanceEligibilitySnapshot(scope: ServerAccountScope): boolean {
    const current = getHomeGovernanceEligibilitySnapshot(scope);
    if (!current || current.stale) return false;
    snapshots.set(keyOf(scope), Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

export function applyHomeGovernanceEligibilityFailure(params: Readonly<{
    scope: ServerAccountScope;
    error: ScopedSnapshotError;
}>): void {
    const current = getHomeGovernanceEligibilitySnapshot(params.scope);
    const authorityWithdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    write(params.scope, Object.freeze({
        scope: params.scope,
        status: 'error',
        data: authorityWithdrawn ? null : current?.data ?? null,
        lastObservedAt: authorityWithdrawn ? null : current?.lastObservedAt ?? null,
        stale: !authorityWithdrawn && current?.data !== null && current?.data !== undefined,
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
}

export function invalidateHomeGovernanceEligibilitySnapshotsForServer(serverIdRaw: string): boolean {
    const serverId = serverIdRaw.trim();
    if (!serverId) return false;
    let changed = false;
    for (const [key, snapshot] of snapshots) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        snapshots.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    if (changed) notify();
    return changed;
}

export function clearHomeGovernanceEligibilitySnapshotsForServer(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    let changed = false;
    for (const [key, snapshot] of snapshots) {
        if (snapshot.scope.serverId !== serverId) continue;
        snapshots.delete(key);
        changed = true;
    }
    if (changed) notify();
}

export function resetHomeGovernanceEligibilitySnapshotsForTests(): void {
    snapshots.clear();
    listeners.clear();
}
