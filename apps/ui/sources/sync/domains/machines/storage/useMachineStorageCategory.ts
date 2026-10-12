import * as React from 'react';
import type { HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import { machineStorageStore, type MachineStorageState, type MachineStorageCategoryState } from './machineStorageStore';
import { useMachineStorageSelection, useMachineStorageTarget, type MachineStorageCategoryHookInput } from './useMachineStorage';

export type MachineStorageCategoryHookResult = MachineStorageCategoryState & Readonly<{
    category: HappierStorageSummaryV1['categories'][number] | null;
    offline: boolean;
    retry: () => void;
    sizeAgain: () => Promise<MachineStorageState>;
}>;

export function useMachineStorageCategory(input: MachineStorageCategoryHookInput): MachineStorageCategoryHookResult {
    const { key, enabled, offline } = useMachineStorageTarget(input);
    const categoryKey = React.useMemo(() => ({ ...key, categoryId: input.categoryId, ...(input.cursor ? { cursor: input.cursor } : {}) }), [key, input.categoryId, input.cursor]);
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observeCategory(categoryKey, listener), [categoryKey]);
    const getSnapshot = React.useCallback(() => machineStorageStore.getCategory(categoryKey), [categoryKey]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const select = React.useCallback((current: ReturnType<typeof machineStorageStore.getState>) => current.summary?.categories.find(category => category.categoryId === input.categoryId) ?? null, [input.categoryId]);
    const category = useMachineStorageSelection(key, select);
    React.useEffect(() => {
        if (!enabled) return;
        return machineStorageStore.demandCategory(categoryKey);
    }, [categoryKey, enabled]);
    const retry = React.useCallback(() => machineStorageStore.retryCategory(categoryKey), [categoryKey]);
    const sizeAgain = React.useCallback(() => machineStorageStore.sizeAgain({ ...key, categoryId: input.categoryId }), [key, input.categoryId]);
    return React.useMemo(() => ({ ...state, category, offline, retry, sizeAgain }), [state, category, offline, retry, sizeAgain]);
}
