import * as React from 'react';
import type { HappierStorageSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineStoragePileResultV1, StorageItemRefV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineStoragePileSetInput, MachineStorageReadInput, MachineStorageResult } from './machineRpc';
import { machineStorageStore, type MachineStorageState } from './machineStorageStore';
import { selectStoragePile, selectStorageStatus, useMachineStorageDemand, useMachineStorageSelection, useMachineStorageTarget, type MachineStorageHookInput } from './useMachineStorage';

export type MachineStoragePileHookResult = Readonly<{
    status: MachineStorageState['status'];
    pile: HappierStorageSummaryV1['pile'] | null;
    offline: boolean;
    retry: () => void;
    /** Pile membership: the machine's refs plus served references still on their way. */
    items: readonly Readonly<StorageItemRefV1>[];
    pending: boolean;
    set: (delta: Omit<MachineStoragePileSetInput, keyof MachineStorageReadInput>) => Promise<MachineStorageResult<MachineStoragePileResultV1>>;
}>;
const EMPTY_ITEMS: readonly Readonly<StorageItemRefV1>[] = [];

export function useMachineStoragePile(input: MachineStorageHookInput): MachineStoragePileHookResult {
    const { key, enabled, offline } = useMachineStorageTarget(input);
    useMachineStorageDemand(key, enabled);
    const status = useMachineStorageSelection(key, selectStorageStatus);
    const pile = useMachineStorageSelection(key, selectStoragePile);
    const subscribe = React.useCallback((listener: () => void) => machineStorageStore.observePile(key, listener), [key]);
    const snapshot = React.useCallback(() => machineStorageStore.getPile(key), [key]);
    const details = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    React.useEffect(() => { if (enabled) return machineStorageStore.demandPile(key); }, [key, enabled]);
    const retry = React.useCallback(() => machineStorageStore.retry(key), [key]);
    const set = React.useCallback<MachineStoragePileHookResult['set']>(delta => enabled
        ? machineStorageStore.setPile({ ...key, ...delta })
        : Promise.resolve({ ok: false, reason: 'request_failed' }), [key, enabled]);
    const items = details.page?.items ?? EMPTY_ITEMS;
    const pending = details.pending;
    return React.useMemo(() => ({ status, pile, offline, retry, items, pending, set }), [status, pile, offline, retry, items, pending, set]);
}
