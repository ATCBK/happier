import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { isMachineResourceStateStale, machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsRange } from './machineRpc';
import { useMachineResourceLiveDemand } from './useMachineResourceLiveDemand';

/**
 * `history` is the daemon's selected-range seed; `samples` is the unchanged raw one-hour live tail.
 * A one-hour chart stitches that tail over older history points, without client rollups/downsampling.
 * Longer ranges and today's totals refresh from the daemon on observed watch minute frontiers.
 */
export function useMachineVitalsOverview(input: MachineResourceKey & Readonly<{ range: MachineVitalsRange; enabled?: boolean }>) {
    const viewed = useHostActivelyViewed();
    const focused = useIsFocused();
    const enabled = focused && input.enabled !== false;
    const key = React.useMemo(() => ({ machineId: input.machineId, serverId: input.serverId ?? null, view: 'overview' as const }), [input.machineId, input.serverId]);
    const historyKey = React.useMemo(() => ({ machineId: input.machineId, serverId: input.serverId ?? null, range: input.range }), [input.machineId, input.range, input.serverId]);
    useMachineResourceLiveDemand([input], { detail: 'overview', enabled });
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => machineResourceStore.getState(key), [key]);
    const subscribeHistory = React.useCallback((listener: () => void) => machineResourceStore.observeHistory(historyKey, listener), [historyKey]);
    const getHistory = React.useCallback(() => machineResourceStore.getHistory(historyKey), [historyKey]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const historyState = React.useSyncExternalStore(subscribeHistory, getHistory, getHistory);
    React.useEffect(() => {
        if (!viewed || !enabled) return;
        return machineResourceStore.demandHistory(historyKey);
    }, [enabled, historyKey, viewed]);
    const retry = React.useCallback(() => {
        machineResourceStore.retry(key);
        machineResourceStore.retryHistory(historyKey);
    }, [historyKey, key]);
    const stale = isMachineResourceStateStale(state, Date.now());
    return React.useMemo(() => ({ ...state, stale, history: historyState.history, historyStatus: historyState.status, retry }), [historyState, retry, stale, state]);
}
