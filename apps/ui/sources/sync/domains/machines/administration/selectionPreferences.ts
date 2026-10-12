import { MachineAdministrationSelectionsV1Schema, MachineAdministrationTargetsV1Schema, type MachineAdministrationTargetsV1, type MachineAdministrationSelectionsV1, type MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';

import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { OneShotAccountSettingsMutationResult } from '@/sync/engine/settings/syncSettings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storageStore';

class PluginOriginSelectionUnavailable extends Error {}

/** Both explicit UI selection and Actions use the same exact-origin admission
 * before the write and again when the asynchronous settings owner applies it. */
export async function persistPluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    expectedSettingsScope: AccountSettingsScope | null;
    expectedSettingsVersion: number | null;
    isOriginCurrent: (origin: PluginMachineExecutionOriginV1) => boolean;
    isInvocationCurrent?: () => boolean;
}>): Promise<OneShotAccountSettingsMutationResult<void> | Readonly<{ status: 'unavailable' }>> {
    const current = () => areAccountSettingsScopesEqual(params.expectedSettingsScope, storage.getState().settingsScope)
        && params.expectedSettingsScope !== null
        && (params.isInvocationCurrent?.() ?? true)
        && (params.origin === null || (getPluginMachineExecutionOriginRef(params.origin).pluginId === params.pluginId
            && params.isOriginCurrent(params.origin)));
    if (params.expectedSettingsVersion === null || !current()) return { status: 'unavailable' };
    try {
        return await persistMachineAdministrationSelectionMutation(params.expectedSettingsScope, params.expectedSettingsVersion, selections => {
            if (!current()) throw new PluginOriginSelectionUnavailable();
            return params.origin === null ? clearPluginMachineExecutionOriginPreference(selections, params.pluginId)
                : setPluginMachineExecutionOriginPreference(selections, params.pluginId, params.origin);
        });
    } catch (error) {
        if (error instanceof PluginOriginSelectionUnavailable) return { status: 'unavailable' };
        throw error;
    }
}

export const MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 = Object.freeze({
    plugins: 'plugins.home',
    agents: 'agents',
    sourceControl: 'sourceControl.settings',
    promptAssets: 'promptAssets.externalAssets',
    promptRegistries: 'promptRegistries.browse',
    mcpServers: 'mcpServers.settings',
    relayDrift: 'server.relayDrift',
    externalSessions: 'externalSessions.settings',
    connectedAccounts: 'connectedAccounts.settings',
    memory: 'memory.settings',
    pets: 'pets.settings',
    providers: 'providers.settings',
    actions: 'actions.settings',
} as const);

/**
 * Builds one device-local named-entry proposal. Validation remains domain-owned.
 */
export function setMachineAdministrationTargetPreference(
    current: MachineAdministrationTargetsV1,
    key: string,
    target: MachineAdministrationTargetV1,
): MachineAdministrationTargetsV1 {
    return MachineAdministrationTargetsV1Schema.parse({
        ...current,
        [key]: target,
    });
}

export function clearMachineAdministrationTargetPreference(
    current: MachineAdministrationTargetsV1,
    key: string,
): MachineAdministrationTargetsV1 {
    const targets = { ...current };
    delete targets[key];
    return MachineAdministrationTargetsV1Schema.parse(targets);
}

export function setPluginMachineExecutionOriginPreference(
    current: MachineAdministrationSelectionsV1,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1,
): MachineAdministrationSelectionsV1 {
    if (getPluginMachineExecutionOriginRef(origin).pluginId !== pluginId) {
        throw new Error('Plugin execution origin must belong to the selected plugin');
    }
    return MachineAdministrationSelectionsV1Schema.parse({
        ...current,
        pluginExecutionOriginsByPluginId: {
            ...current.pluginExecutionOriginsByPluginId,
            [pluginId]: origin,
        },
    });
}

export function clearPluginMachineExecutionOriginPreference(
    current: MachineAdministrationSelectionsV1,
    pluginId: string,
): MachineAdministrationSelectionsV1 {
    const pluginExecutionOriginsByPluginId = { ...current.pluginExecutionOriginsByPluginId };
    delete pluginExecutionOriginsByPluginId[pluginId];
    return MachineAdministrationSelectionsV1Schema.parse({
        ...current,
        pluginExecutionOriginsByPluginId,
    });
}

/**
 * Replays one Administration-owned named-entry mutation against the current
 * Account Settings CAS winner. Unknown root settings and concurrent sibling
 * selections remain owned by that winner rather than by a rendered snapshot.
 */
export function applyMachineAdministrationSelectionMutationToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    mutate: (current: MachineAdministrationSelectionsV1) => MachineAdministrationSelectionsV1,
): Record<string, unknown> {
    const retained = raw.machineAdministrationSelectionsV1 ?? {};
    const parsed = ACCOUNT_SETTING_DEFINITIONS.machineAdministrationSelectionsV1.parseStoredValue(retained);
    if (!parsed.success) throw new Error('Invalid stored machine administration selections');
    const current = MachineAdministrationSelectionsV1Schema.parse(parsed.data);
    const next = MachineAdministrationSelectionsV1Schema.parse(mutate(current));
    // Stored reads accept additive fields; only changed named origins are new
    // writes. Retain opaque container and unchanged sibling fields verbatim.
    const retainedRecord = retained as Readonly<Record<string, unknown>>;
    const origins = { ...(retainedRecord.pluginExecutionOriginsByPluginId as Readonly<Record<string, unknown>> | undefined) };
    for (const pluginId of new Set([
        ...Object.keys(current.pluginExecutionOriginsByPluginId),
        ...Object.keys(next.pluginExecutionOriginsByPluginId),
    ])) {
        if (areAccountSettingsJsonValuesEqual(current.pluginExecutionOriginsByPluginId[pluginId], next.pluginExecutionOriginsByPluginId[pluginId])) continue;
        if (Object.hasOwn(next.pluginExecutionOriginsByPluginId, pluginId)) origins[pluginId] = next.pluginExecutionOriginsByPluginId[pluginId];
        else delete origins[pluginId];
    }
    return {
        ...raw,
        machineAdministrationSelectionsV1: { ...retainedRecord, ...next, pluginExecutionOriginsByPluginId: origins },
    };
}

export async function persistMachineAdministrationSelectionMutation(
    expectedSettingsScope: AccountSettingsScope | null,
    expectedSettingsVersion: number,
    mutate: (current: MachineAdministrationSelectionsV1) => MachineAdministrationSelectionsV1,
): Promise<OneShotAccountSettingsMutationResult<void>> {
    return await getSyncSingleton().mutateAccountSettingsOnce({
        expectedSettingsScope,
        expectedSettingsVersion,
        mutate: (raw) => ({
            settings: applyMachineAdministrationSelectionMutationToAccountSettings(raw, mutate),
            value: undefined,
        }),
    });
}
