import * as React from 'react';
import { machineStorageStore, type MachineStorageItemsState } from './machineStorageStore';
import { useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';
import type { MachineStorageItemsInput } from './machineRpc';

export type MachineStorageItemsHookInput = MachineStorageHookInput & Pick<MachineStorageItemsInput, 'list' | 'projectId' | 'filter' | 'group' | 'quickestForVolume'>;
export type MachineStorageItemsHookResult = MachineStorageItemsState & Readonly<{ offline: boolean; retry: () => void }>;

/** Worktrees or Suggestions for one machine (`worktrees.list` / `suggestions.list`), read again on each storage revision. */
export function useMachineStorageItems(input: MachineStorageItemsHookInput): MachineStorageItemsHookResult {
    const { key, enabled, offline } = useMachineStorageTarget(input);
    const listInput = React.useMemo((): MachineStorageItemsInput => ({ ...key, list: input.list,
        ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.filter ? { filter: input.filter } : {}),
        ...(input.group ? { group: input.group } : {}), ...(input.quickestForVolume ? { quickestForVolume: input.quickestForVolume } : {}) }),
    [key, input.list, input.projectId, input.filter, input.group, input.quickestForVolume]);
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observeItems(listInput, listener), [listInput]);
    const snapshot = React.useCallback(() => machineStorageStore.getItems(listInput), [listInput]);
    const state = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    React.useEffect(() => { if (enabled) return machineStorageStore.demandItems(listInput); }, [enabled, listInput]);
    const retry = React.useCallback(() => machineStorageStore.retryItems(listInput), [listInput]);
    return React.useMemo(() => ({ ...state, offline, retry }), [state, offline, retry]);
}
