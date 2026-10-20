import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { isMachineResourceStateStale, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import type { MachineResourceKey } from '@/sync/domains/machines/resources/machineRpc';
import { retryMachineResourceSummaries } from '@/sync/domains/machines/resources/retryMachineResourceSummaries';
import { readMachineResourceReadStatus } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useMachineDaemonReadIdentities } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';

/**
 * "As of 10:42 · Retry" while the summaries a surface shows stopped answering (MPG-18 stale, or a read that
 * failed twice): the oldest held sample's time and the one recovery, as the machine page's chip says it. A
 * first failed watch is only "Slow to answer · Retry" with every value kept (M-15). Otherwise the surface's
 * own line (`fallback`) stands. The strips themselves dim one step; this line is the only words about it.
 * The chip gives way before Retry does, so it fits a 372 px popover in any locale.
 */
export function MachineSummaryFreshnessLine(props: Readonly<{ machineKeys: readonly MachineResourceKey[]; fallback: React.ReactNode }>) {
    const { machineKeys } = props;
    const identities = useMachineDaemonReadIdentities(machineKeys);
    const qualifiedKeys = React.useMemo(() => identities.filter(identity => identity.accountMatches).map(identity => identity.key), [identities]);
    const inputs = React.useMemo(() => qualifiedKeys.map(key => ({ ...key, view: 'summary' as const })), [qualifiedKeys]);
    const subscribe = React.useCallback((listener: () => void) => {
        const stops = inputs.map(input => machineResourceStore.observe(input, listener));
        return () => { for (const stop of stops) stop(); };
    }, [inputs]);
    const readStaleSince = React.useCallback(() => {
        let oldest: number | null = null;
        const now = Date.now();
        for (const input of inputs) {
            const state = machineResourceStore.getState(input);
            if (!state.summary) continue;
            if (!isMachineResourceStateStale(state, now) && readMachineResourceReadStatus(state) !== 'error') continue;
            oldest = oldest === null ? state.summary.sampledAt : Math.min(oldest, state.summary.sampledAt);
        }
        return oldest;
    }, [inputs]);
    const readSlow = React.useCallback(
        () => inputs.some(input => readMachineResourceReadStatus(machineResourceStore.getState(input)) === 'slow'),
        [inputs],
    );
    const staleSince = React.useSyncExternalStore(subscribe, readStaleSince, readStaleSince);
    const slow = React.useSyncExternalStore(subscribe, readSlow, readSlow);
    if (staleSince === null && !slow) return <>{props.fallback}</>;
    return (
        <SurfaceFreshnessLine
            testID="machines.summary.stale"
            presentation="chip"
            asOf={staleSince}
            reason={staleSince === null ? t('machineSummary.slowReason') : ''}
            action={{ label: t('common.retry'), onPress: () => retryMachineResourceSummaries(qualifiedKeys) }}
        />
    );
}
