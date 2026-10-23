import * as React from 'react';

import { storage } from '@/sync/domains/state/storageStore';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveNewSessionTargetMachines } from '@/components/sessions/new/modules/newSessionPlacementSources';

/** Read the target Home at placement intent; visible facts have their own exact/scoped subscribers. */
export function useNewSessionPlacementMachines(params: Readonly<{
    serverId: string | null;
    activeServerId: string;
}>) {
    return React.useCallback(() => {
        const state = storage.getState();
        return resolveNewSessionTargetMachines({
            targetServerId: params.serverId,
            activeServerId: params.activeServerId,
            activeMachines: resolveVisibleMachinesForActiveServerFromState(state, { serverId: params.activeServerId }),
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }).filter(isMachineVisibleForSelection);
    }, [params.activeServerId, params.serverId]);
}
