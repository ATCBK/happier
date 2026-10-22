import * as React from 'react';

import { useMachineUpdateFactsBackground } from './useMachineUpdateFactsBackground';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';

function sameMachineIds(previous: readonly string[], next: readonly string[]): boolean {
    return previous.length === next.length && previous.every((id, index) => id === next[index]);
}

/**
 * Keeps the Updates summary's coverage: asks each online machine for its tools' update facts
 * through the installables background owner, whenever the server or its set of online machines changes. The
 * owner's freshness policy decides whether anything is actually sent; no timer re-asks. Renders
 * nothing; the summary only observes the cache this fills.
 */
export function UpdateFactsBackgroundRuntime(props: Readonly<{ enabled: boolean }>): null {
    // These machines' server: the facts land in that server's cache entries, the ones the summary reads.
    const serverId = useActiveServerSnapshot().serverId;
    const activeScope = useActiveServerAccountScope();
    const accountScope = activeScope?.serverId === serverId ? activeScope : null;
    const readMachines = React.useCallback(() => resolveVisibleMachinesForActiveServerFromState(storage.getState(), { serverId }), [serverId]);
    const readSelectableIds = React.useCallback((nowMs: number) => readMachines()
        .filter(machine => isMachineSelectableForFleet(accountScope, machine, nowMs))
        .map(machine => machine.id).sort(), [accountScope, readMachines]);
    const machineIds = useMachinePresenceSnapshot(readMachines, readSelectableIds, sameMachineIds);
    useMachineUpdateFactsBackground({ serverId, accountId: accountScope?.accountId,
        machineIds, enabled: props.enabled });
    return null;
}
