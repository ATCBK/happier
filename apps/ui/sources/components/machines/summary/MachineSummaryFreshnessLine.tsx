import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { isMachineResourceStateStale, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import type { MachineResourceKey } from '@/sync/domains/machines/resources/machineRpc';
import { retryMachineResourceSummaries } from '@/sync/domains/machines/resources/retryMachineResourceSummaries';
import { t } from '@/text';

/**
 * "As of 10:42 · Retry" while the summaries a surface shows stopped answering (MPG-18 stale): the oldest
 * held sample's time and the one recovery. Otherwise the surface's own line (`fallback`) stands. The
 * strips themselves dim one step; this line is the only words about it.
 */
export function MachineSummaryFreshnessLine(props: Readonly<{ machineKeys: readonly MachineResourceKey[]; fallback: React.ReactNode }>) {
    const { machineKeys } = props;
    const inputs = React.useMemo(() => machineKeys.map(key => ({ ...key, view: 'summary' as const })), [machineKeys]);
    const subscribe = React.useCallback((listener: () => void) => {
        const stops = inputs.map(input => machineResourceStore.observe(input, listener));
        return () => { for (const stop of stops) stop(); };
    }, [inputs]);
    const read = React.useCallback(() => {
        let oldest: number | null = null;
        const now = Date.now();
        for (const input of inputs) {
            const state = machineResourceStore.getState(input);
            if (!state.summary || !isMachineResourceStateStale(state, now)) continue;
            oldest = oldest === null ? state.summary.sampledAt : Math.min(oldest, state.summary.sampledAt);
        }
        return oldest;
    }, [inputs]);
    const staleSince = React.useSyncExternalStore(subscribe, read, read);
    if (staleSince === null) return <>{props.fallback}</>;
    return (
        <SurfaceFreshnessLine
            testID="machines.summary.stale"
            asOf={staleSince}
            reason={t('machineSummary.staleReason')}
            action={{ label: t('common.retry'), onPress: () => retryMachineResourceSummaries(machineKeys) }}
        />
    );
}
