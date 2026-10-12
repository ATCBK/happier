import * as React from 'react';
import { machineStorageStore, type MachineStorageState } from './machineStorageStore';
import { selectStorageStatus, selectStorageSummary, useMachineStorageDemand, useMachineStorageSelection, useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';

export type MachineStorageSummaryHookResult = MachineStorageState & Readonly<{
    offline: boolean;
    retry: () => void;
    sizeAgain: () => Promise<MachineStorageState>;
}>;

export function useMachineStorageSummary(input: MachineStorageHookInput): MachineStorageSummaryHookResult {
    const { key, enabled, offline } = useMachineStorageTarget(input);
    useMachineStorageDemand(key, enabled);
    const status = useMachineStorageSelection(key, selectStorageStatus);
    const summary = useMachineStorageSelection(key, selectStorageSummary);
    const retry = React.useCallback(() => machineStorageStore.retry(key), [key]);
    const sizeAgain = React.useCallback(() => machineStorageStore.sizeAgain(key), [key]);
    return React.useMemo(() => ({ status, summary, offline, retry, sizeAgain }), [status, summary, offline, retry, sizeAgain]);
}
