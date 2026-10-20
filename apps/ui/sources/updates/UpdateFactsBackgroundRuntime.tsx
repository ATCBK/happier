import * as React from 'react';

import { useMachineUpdateFactsBackground } from './useMachineUpdateFactsBackground';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';

/**
 * Keeps the Updates summary's coverage: asks each online machine for its tools' update facts
 * through the installables background owner, whenever the server or its set of online machines changes. The
 * owner's freshness policy decides whether anything is actually sent; no timer re-asks. Renders
 * nothing; the summary only observes the cache this fills.
 */
export function UpdateFactsBackgroundRuntime(props: Readonly<{ enabled: boolean }>): null {
    const machines = useAllMachines();
    // These machines' server: the facts land in that server's cache entries, the ones the summary reads.
    const serverId = useActiveServerSnapshot().serverId;
    const activeScope = useActiveServerAccountScope();
    const accountScope = activeScope?.serverId === serverId ? activeScope : null;
    const reachabilityRevision = useMachineReachabilityRevision(props.enabled);
    const presenceNowMs = useMachinePresenceNowMs(machines);
    const onlineKey = React.useMemo(
        () => machines.filter((machine) => isMachineSelectableForFleet(accountScope, machine, presenceNowMs)).map((machine) => machine.id).sort().join('\u0000'),
        [machines, accountScope, reachabilityRevision, presenceNowMs],
    );
    useMachineUpdateFactsBackground({ serverId, accountId: accountScope?.accountId,
        machineIds: onlineKey ? onlineKey.split('\u0000') : [], enabled: props.enabled });
    return null;
}
