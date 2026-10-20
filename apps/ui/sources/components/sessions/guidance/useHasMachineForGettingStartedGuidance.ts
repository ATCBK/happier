import * as React from 'react';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { resolveMachineSetupSatisfied } from '@/components/machines/add/machineAddPaths';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useLaunchSelectionMachines, useMachineListByServerId } from '@/sync/domains/state/storage';

import { resolveSessionGettingStartedMachinesSummary } from './gettingStartedModel';
import { useSessionGettingStartedActiveServerProfile } from './useSessionGettingStartedActiveServerProfile';

/** The getting-started selection is unknown until loaded; offline machines count, revoked ones do not. */
export function useHasMachineForGettingStartedGuidance(): boolean | null {
    const selection = useResolvedActiveServerSelection();
    const bindings = useServerCredentialAccountScopeBindings([...selection.allowedServerIds, selection.activeServerId]);
    const activeMachines = useLaunchSelectionMachines();
    const machineListByServerId = useMachineListByServerId(true, 'launch');
    const activeServerProfile = useSessionGettingStartedActiveServerProfile(selection.activeServerId);

    return React.useMemo(() => resolveMachineSetupSatisfied(resolveSessionGettingStartedMachinesSummary({
        activeMachines,
        accountScopesByServerId: bindings,
        selection: {
            activeTarget: selection.activeTarget,
            activeServerId: selection.activeServerId,
            allowedServerIds: selection.allowedServerIds,
        },
        activeServerProfile,
        machineListByServerId,
    })), [
        activeMachines,
        activeServerProfile,
        machineListByServerId,
        selection.activeServerId,
        selection.activeTarget,
        selection.allowedServerIds,
        bindings,
    ]);
}
