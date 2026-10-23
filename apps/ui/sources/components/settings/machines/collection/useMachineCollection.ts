import * as React from 'react';

import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { areSessionValuesDeepEqual } from '@/sync/store/domains/areStoredSessionsEqual';

import { buildMachineCollection, type MachineCollection } from './machineCollectionModel';

/** Project roster labels through the same recovery, withdrawal and expiry subscription as admission. */
export function useMachineCollection(input: Omit<Parameters<typeof buildMachineCollection>[0], 'nowMs'>): MachineCollection {
    const { groups, groupedByHome, query, managedByServerId, presetsByServerId, teamNamesByServerId, awaitingConsent } = input;
    const readMachines = React.useCallback(() => groups.flatMap(group => group.machines), [groups]);
    const readCollection = React.useCallback((nowMs: number) => buildMachineCollection({
        groups, groupedByHome, query, managedByServerId, presetsByServerId, teamNamesByServerId, awaitingConsent, nowMs,
    }), [groups, groupedByHome, query, managedByServerId, presetsByServerId, teamNamesByServerId, awaitingConsent]);
    // Heartbeats retain semantic inventory identity. Presence recovery still has
    // to refresh labels; unchanged projections keep unrelated rows quiet.
    return useMachinePresenceSnapshot(readMachines, readCollection, areSessionValuesDeepEqual);
}
