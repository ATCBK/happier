import * as React from 'react';

import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useNewSessionCapabilitiesPrefetch } from '@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useStableRecentPathsForMachine } from '@/utils/sessions/useStableRecentPathsForMachine';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';

type RecentMachinePath = Readonly<{
    machineId: string;
    path: string;
}>;

function buildMachineRefreshItemSignature(machine: Machine): string {
    const metadata = machine.metadata;
    return [
        machine.id,
        String(machine.active === true),
        String(machine.revokedAt ?? ''),
        String(machine.replacedByMachineId ?? ''),
        String(machine.daemonStateVersion ?? ''),
        String(metadata?.displayName ?? ''),
        String(metadata?.host ?? ''),
        String(metadata?.homeDir ?? ''),
        String(metadata?.platform ?? ''),
    ].join('|');
}

function buildMachineRefreshListSignature(machines: ReadonlyArray<Machine>): string {
    return machines.map(buildMachineRefreshItemSignature).join('\n');
}

function useStableValueBySignature<Value>(value: Value, signature: string): Value {
    const stableRef = React.useRef<Readonly<{ signature: string; value: Value }> | null>(null);
    if (!stableRef.current || stableRef.current.signature !== signature) {
        stableRef.current = { signature, value };
    }
    return stableRef.current.value;
}

export function useNewSessionMachineRefreshState(params: Readonly<{
    focused?: boolean;
    capabilityServerId: string;
    selectedMachineId: string | null;
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: ReadonlyArray<RecentMachinePath>;
    sessions?: ReadonlyArray<Session | string> | null | undefined;
    favoriteMachines: ReadonlyArray<string>;
    useEnhancedSessionWizard: boolean;
    refreshMachineEnvPresence: () => void;
}>): Readonly<{
    refreshMachineData: () => void;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    recentPaths: ReadonlyArray<string>;
}> {
    const reachabilityRevision = useMachineReachabilityRevision();
    const { binding } = useServerCredentialAccountScopeBinding(params.capabilityServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const machineReachable = React.useCallback(
        (machine: Machine) => isMachineReachable(scope, machine),
        [scope, reachabilityRevision],
    );
    const manualRefreshLifetime = React.useMemo(() => ({ controller: new AbortController() }), [params.capabilityServerId, params.selectedMachineId, params.focused]);
    React.useEffect(() => {
        if (params.focused === false) { manualRefreshLifetime.controller.abort(); return; }
        if (manualRefreshLifetime.controller.signal.aborted) manualRefreshLifetime.controller = new AbortController();
        const controller = manualRefreshLifetime.controller;
        return () => controller.abort();
    }, [manualRefreshLifetime, params.focused]);
    const refreshMachineData = React.useCallback(() => {
        if (manualRefreshLifetime.controller.signal.aborted) return;
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.manual' });
        params.refreshMachineEnvPresence();

        if (params.selectedMachineId) {
            const selectedMachine = params.machines.find((machine) => machine.id === params.selectedMachineId) ?? null;
            fireAndForget(prefetchMachineCapabilities({
                machineId: params.selectedMachineId,
                serverId: params.capabilityServerId,
                cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt(selectedMachine, params.capabilityServerId),
                signal: manualRefreshLifetime.controller.signal,
                request: { ...CAPABILITIES_REQUEST_NEW_SESSION, bypassCache: true },
            }), { tag: 'NewSessionScreenModel.prefetchMachineCapabilities' });
        }
    }, [params.capabilityServerId, params.machines, params.refreshMachineEnvPresence, params.selectedMachineId, manualRefreshLifetime]);

    const rawRecentMachines = React.useMemo(() => {
        if (params.machines.length === 0) return [];
        if (params.recentMachinePaths.length === 0) return [];

        const byId = new Map(params.machines.map((machine) => [machine.id, machine] as const));
        const seen = new Set<string>();
        const result: Machine[] = [];
        for (const entry of params.recentMachinePaths) {
            if (seen.has(entry.machineId)) continue;
            const machine = byId.get(entry.machineId);
            if (!machine) continue;
            seen.add(entry.machineId);
            result.push(machine);
        }
        return result;
    }, [params.machines, params.recentMachinePaths]);
    const recentMachinesSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawRecentMachines),
        [rawRecentMachines],
    );
    const recentMachines = useStableValueBySignature(rawRecentMachines, recentMachinesSignature);

    const rawFavoriteMachineItems = React.useMemo(() => {
        return params.machines.filter((machine) => params.favoriteMachines.includes(machine.id));
    }, [params.favoriteMachines, params.machines]);
    const favoriteMachineItemsSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawFavoriteMachineItems),
        [rawFavoriteMachineItems],
    );
    const favoriteMachineItems = useStableValueBySignature(rawFavoriteMachineItems, favoriteMachineItemsSignature);

    useNewSessionCapabilitiesPrefetch({
        enabled: params.useEnhancedSessionWizard && params.focused !== false,
        serverId: params.capabilityServerId,
        machines: params.machines,
        favoriteMachineItems,
        recentMachines,
        selectedMachineId: params.selectedMachineId,
        isMachineOnline: machineReachable,
        staleMs: 2 * 60 * 1000,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
        prefetchMachineCapabilitiesIfStale,
    });

    const recentPaths = useStableRecentPathsForMachine({
        machineId: params.selectedMachineId,
        recentMachinePaths: params.recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.capabilityServerId,
    });

    return {
        refreshMachineData,
        recentMachines,
        favoriteMachineItems,
        recentPaths,
    };
}
