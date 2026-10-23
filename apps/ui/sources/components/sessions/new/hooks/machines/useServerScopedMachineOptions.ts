import * as React from 'react';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';

export type ServerScopedMachinePresentation = MachineDisplayRenderable & Readonly<{
    serverId: string;
    serverName: string;
}>;

export type ServerScopedMachine = Machine & ServerScopedMachinePresentation;

export type ServerScopedMachineGroup<
    TMachine extends ServerScopedMachinePresentation = ServerScopedMachine,
> = Readonly<{
    serverId: string;
    serverName: string;
    machines: TMachine[];
    loading: boolean;
    signedOut: boolean;
    error?: boolean;
}>;

type UseServerScopedMachineOptionsParams = Readonly<{
    allowedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    activeMachines: ReadonlyArray<Machine>;
    refreshToken?: string | number;
    /** Hidden retained composers keep their last inventory until presented again. */
    presented?: boolean;
    inventoryPurpose?: 'full' | 'launch';
}>;

function normalizeServerIds(ids: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        next.push(id);
    }
    return next;
}

function buildServerScopedMachine(machine: Machine, params: Readonly<{ serverId: string; serverName: string }>): ServerScopedMachine {
    return {
        ...machine,
        // Semantic inventory stays stable across heartbeats. Keep its receipt
        // fields attached to the source instead of freezing an old lease here.
        get activeAt() { return machine.activeAt; },
        get updatedAt() { return machine.updatedAt; },
        serverId: params.serverId,
        serverName: params.serverName,
    };
}

function buildServerProfilesSignature(profilesById: ReadonlyMap<string, ServerProfile>): string {
    return Array.from(profilesById.values())
        .map((profile) => [
            profile.id,
            resolveHomeDisplayLabel(profile, profile.id),
            profile.serverIdentityId ?? '',
            ...(profile.legacyServerIds ?? []),
        ].join('|'))
        .sort()
        .join('\n');
}

function useStableValueBySignature<Value>(value: Value, signature: string): Value {
    const stableRef = React.useRef<Readonly<{ signature: string; value: Value }> | null>(null);
    if (!stableRef.current || stableRef.current.signature !== signature) {
        stableRef.current = { signature, value };
    }
    return stableRef.current.value;
}

export function useServerScopedMachineOptions(params: UseServerScopedMachineOptionsParams): ServerScopedMachineGroup[] {
    const allowedServerIdsKey = React.useMemo(
        () => normalizeServerIds(params.allowedServerIds).join('\n'),
        [params.allowedServerIds],
    );
    const allowedServerIds = React.useMemo(
        () => allowedServerIdsKey ? allowedServerIdsKey.split('\n') : [],
        [allowedServerIdsKey],
    );
    const rawServerProfiles = React.useMemo(() => {
        const byId = new Map<string, ServerProfile>();
        for (const profile of listServerProfiles()) {
            byId.set(profile.id, profile);
        }
        return byId;
    }, [params.refreshToken, allowedServerIdsKey]);
    const serverProfilesSignature = React.useMemo(
        () => buildServerProfilesSignature(rawServerProfiles),
        [rawServerProfiles],
    );
    const serverProfiles = useStableValueBySignature(rawServerProfiles, serverProfilesSignature);
    const machineListByServerId = useMachineListByServerId(params.presented, params.inventoryPurpose);
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        const activeServerId = String(params.activeServerId ?? '').trim();
        return allowedServerIds.map((serverId) => {
            const profile = serverProfiles.get(serverId);
            const serverName = resolveHomeDisplayLabel(profile, serverId);
            const isActive = Boolean(activeServerId) && areServerProfileIdentifiersEquivalent(serverId, activeServerId);
            const inventory = resolveServerScopedMachineInventory({
                serverId,
                activeServerId,
                activeMachines: params.activeMachines,
                machineListByServerId,
                machineListStatusByServerId,
            });
            const signedOut = inventory.status === 'signedOut';
            const error = inventory.status === 'error';
            const loading = !isActive && !signedOut && !error && inventory.machines === null;
            const machines = (inventory.machines ?? [])
                .filter(isMachineVisibleForLaunchSelection)
                .map((machine) => buildServerScopedMachine(machine, { serverId, serverName }));
            return {
                serverId,
                serverName,
                machines,
                loading,
                signedOut,
                error,
            };
        });
    }, [
        allowedServerIds,
        params.activeMachines,
        machineListByServerId,
        machineListStatusByServerId,
        params.activeServerId,
        serverProfiles,
    ]);
}
