import * as React from 'react';

import {
    serverAccountScopeListKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    observeHomeGovernanceEligibility,
    refreshHomeGovernanceEligibility,
} from '@/sync/engine/home/governance/homeGovernanceEligibilityEngine';
import {
    getHomeGovernanceEligibilitySnapshot,
    getHomeGovernanceEligibilitySnapshotsSelectionKey,
    subscribeHomeGovernanceEligibilitySnapshots,
    type HomeGovernanceEligibilitySnapshot,
} from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';

export type HomeGovernanceEligibilitySnapshotsBinding = Readonly<{
    snapshotsByServerId: ReadonlyMap<string, HomeGovernanceEligibilitySnapshot>;
    refresh: () => void;
}>;

export function useHomeGovernanceEligibilitySnapshots(
    scopes: readonly ServerAccountScope[],
): HomeGovernanceEligibilitySnapshotsBinding {
    const scopesKey = serverAccountScopeListKey(scopes);

    React.useEffect(() => {
        const releases = scopes.map(observeHomeGovernanceEligibility);
        return () => releases.forEach((release) => release());
        // The serialized exact scopes are the observation identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopesKey]);

    const getSelectionKey = React.useCallback(
        () => getHomeGovernanceEligibilitySnapshotsSelectionKey(scopes),
        // The serialized scopes carry this selection's exact identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [scopesKey],
    );
    const selectionKey = React.useSyncExternalStore(
        subscribeHomeGovernanceEligibilitySnapshots,
        getSelectionKey,
        getSelectionKey,
    );

    const snapshotsByServerId = React.useMemo(() => {
        const out = new Map<string, HomeGovernanceEligibilitySnapshot>();
        for (const scope of scopes) {
            const snapshot = getHomeGovernanceEligibilitySnapshot(scope);
            if (snapshot) out.set(scope.serverId, snapshot);
        }
        return out;
        // Only changed snapshots in this selection invalidate the projection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopesKey, selectionKey]);

    const refresh = React.useCallback(() => {
        for (const scope of scopes) void refreshHomeGovernanceEligibility(scope);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopesKey]);

    return React.useMemo(() => ({ snapshotsByServerId, refresh }), [snapshotsByServerId, refresh]);
}
