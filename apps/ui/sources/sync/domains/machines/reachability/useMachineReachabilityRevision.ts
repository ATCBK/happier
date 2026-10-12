import * as React from 'react';

import {
    readMachineRequestReachabilityRevision,
    subscribeMachineRequestReachability,
} from './machineReachability';

const subscribeDisabledReachability = () => () => {};
const readDisabledReachabilityRevision = () => 0;

/** Re-render a projection that reads server-scoped reachability observations. */
export function useMachineReachabilityRevision(enabled = true): number {
    return React.useSyncExternalStore(
        enabled ? subscribeMachineRequestReachability : subscribeDisabledReachability,
        enabled ? readMachineRequestReachabilityRevision : readDisabledReachabilityRevision,
        enabled ? readMachineRequestReachabilityRevision : readDisabledReachabilityRevision,
    );
}
