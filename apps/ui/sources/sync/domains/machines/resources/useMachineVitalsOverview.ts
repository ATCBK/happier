import * as React from 'react';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useMachineDaemonReadTarget } from '../useMachineDaemonReadTarget';
import { EMPTY_MACHINE_RESOURCE_STATE, EMPTY_MACHINE_RESOURCE_HISTORY_STATE, isMachineResourceStateStale, machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsRange } from './machineRpc';
import { useMachineResourceLiveDemand } from './useMachineResourceLiveDemand';

/**
 * `history` is the daemon's selected-range seed; `samples` is the unchanged raw one-hour live tail.
 * A one-hour chart stitches that tail over older history points, without client rollups/downsampling.
 * Longer ranges and today's totals refresh from the daemon on observed watch minute frontiers.
 */
export function useMachineVitalsOverview(input: MachineResourceKey & Readonly<{ range: MachineVitalsRange; enabled?: boolean }>) {
    const target = useMachineDaemonReadTarget(input);
    const focused = useDestinationFocus();
    // Visible workspace split panes share presentation, even when only one has keyboard focus.
    const hosted = useDestinationInstanceKey() !== null;
    const enabled = target.enabled && (hosted || focused);
    const key = React.useMemo(() => ({ ...target.key, view: 'overview' as const }), [target.key]);
    const historyKey = React.useMemo(() => ({ ...target.key, range: input.range }), [input.range, target.key]);
    useMachineResourceLiveDemand([{ ...target.key, daemonStateVersion: target.daemonStateVersion }], { detail: 'overview', enabled });
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, target.accountMatches]);
    const subscribeHistory = React.useCallback((listener: () => void) => machineResourceStore.observeHistory(historyKey, listener), [historyKey]);
    const getHistory = React.useCallback(() => target.accountMatches ? machineResourceStore.getHistory(historyKey) : EMPTY_MACHINE_RESOURCE_HISTORY_STATE, [historyKey, target.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const historyState = React.useSyncExternalStore(subscribeHistory, getHistory, getHistory);
    React.useEffect(() => {
        if (!enabled || !target.accountBinding) return;
        const release = machineResourceStore.demandHistory(historyKey);
        const retirement = target.accountBinding.onRetire(release);
        return () => { retirement.dispose(); release(); };
    }, [enabled, historyKey, target.accountBinding]);
    const retry = React.useCallback(() => {
        if (!enabled) return;
        machineResourceStore.retry(key);
        machineResourceStore.retryHistory(historyKey);
    }, [enabled, historyKey, key]);
    const stale = isMachineResourceStateStale(state, Date.now());
    return React.useMemo(() => ({ ...state, stale, history: historyState.history, historyStatus: historyState.status, retry }), [historyState, retry, stale, state]);
}
