import * as React from 'react';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

/** Presence surfaces request their grace expiry from the existing shared runtime clock. */
export function useMachinePresenceNowMs(machines: readonly Parameters<typeof readMachineStatusNextRefreshAtMs>[0][]): number {
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => {
        let next: number | null = null;
        for (const machine of machines) {
            const at = readMachineStatusNextRefreshAtMs(machine, nowMs);
            if (at !== null) next = next === null ? at : Math.min(next, at);
        }
        return next;
    }, [machines]);
    return useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, machines.length > 0);
}
