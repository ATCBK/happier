import * as React from 'react';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';

/** Mounted visible surfaces own demand; passive row readers never start an RPC. */
export function useMachineResourceLiveDemand(machineKeys: readonly MachineResourceKey[], options: Readonly<{ detail: MachineVitalsView; enabled?: boolean }>): void {
    const viewed = useHostActivelyViewed();
    const enabled = options.enabled ?? true;
    const byKey = new Map(machineKeys.map(input => [JSON.stringify([input.serverId ?? null, input.machineId]), input]));
    const targetKey = JSON.stringify([...byKey.keys()].sort());
    const targets = React.useMemo(() => [...byKey.values()], [targetKey]);
    const latestKeys = React.useRef(machineKeys);
    latestKeys.current = machineKeys;
    const versionsKey = JSON.stringify(machineKeys.map(input => [input.serverId ?? null, input.machineId, input.daemonStateVersion ?? null]));

    React.useEffect(() => {
        for (const input of latestKeys.current) machineResourceStore.daemonStateChanged(input, input.daemonStateVersion);
    }, [versionsKey]);

    React.useEffect(() => {
        if (!viewed || !enabled) return;
        const releases = targets.map(input => machineResourceStore.demand({ ...input, view: options.detail }));
        return () => { for (const release of releases) release(); };
    }, [enabled, options.detail, targets, viewed]);
}
