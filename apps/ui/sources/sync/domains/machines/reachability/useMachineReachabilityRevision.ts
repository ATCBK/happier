import * as React from 'react';

import {
    readMachineRequestReachabilityRevision,
    subscribeMachineRequestReachability,
} from './machineReachability';

/** Re-render a projection that reads server-scoped reachability observations. */
export function useMachineReachabilityRevision(): number {
    return React.useSyncExternalStore(
        subscribeMachineRequestReachability,
        readMachineRequestReachabilityRevision,
        readMachineRequestReachabilityRevision,
    );
}
