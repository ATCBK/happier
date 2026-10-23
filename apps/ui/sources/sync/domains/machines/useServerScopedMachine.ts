import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { resolveServerScopedMachine } from './resolveServerScopedMachine';

/** Observe one canonical Home-scoped row without subscribing to the fleet inventory. */
export function useServerScopedMachine(serverId: string | null, machineId: string | null): Machine | null {
    const activeServerId = useActiveServerSnapshot().serverId;
    const profilesGeneration = useServerProfilesGeneration();
    const select = React.useCallback((state: StorageState) => (
        machineId === null ? null : resolveServerScopedMachine(state, serverId ?? activeServerId, machineId)
    ), [activeServerId, machineId, profilesGeneration, serverId]);
    return getStorage()(select);
}
