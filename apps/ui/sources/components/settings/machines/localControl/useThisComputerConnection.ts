import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { storage as syncStorage } from '@/sync/domains/state/storageStore';
import {
    resolveThisComputerConnection,
    type ThisComputerConnection,
} from '@/sync/domains/server/relayDrift/thisComputerConnection';

import type { LocalDaemonStatusData } from './useLocalDaemonControl';

/** The signed-in account's id and readable label, as every "this computer" sentence names it. */
export function useAppAccountIdentity(): Readonly<{ accountId: string | null; accountLabel: string | null }> {
    const accountId = syncStorage((state) => {
        const id = state.profile?.id?.trim();
        return id ? id : null;
    });
    const accountLabel = syncStorage((state) => (state.profile ? formatAccountDisplayName(state.profile) : null));
    return React.useMemo(() => ({ accountId, accountLabel }), [accountId, accountLabel]);
}

/**
 * How this computer's daemon relates to the Home and account the app is on — the one
 * classification every surface describing this computer consumes. Pass the status of the
 * `useLocalDaemonControl` instance the caller already owns, so reading it never starts a second
 * status task. `null` while nothing is known (no local bridge, as on web, or no daemon).
 */
export function useThisComputerConnection(status: LocalDaemonStatusData | null): ThisComputerConnection | null {
    const activeServerSnapshot = useActiveServerSnapshot();
    const { accountId, accountLabel } = useAppAccountIdentity();
    return React.useMemo(() => resolveThisComputerConnection({
        daemon: status,
        activeRelayUrl: activeServerSnapshot.serverUrl,
        activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl ?? null,
        appAccountId: accountId,
        appAccountLabel: accountLabel,
    }), [
        accountId,
        accountLabel,
        activeServerSnapshot.activeLocalRelayUrl,
        activeServerSnapshot.serverUrl,
        status,
    ]);
}
