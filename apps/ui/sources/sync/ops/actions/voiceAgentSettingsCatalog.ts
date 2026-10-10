import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import type { captureLazyActionAccountContext } from './actionAccountContext';
import { readAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { isAcpCatalogCaptureCurrent } from '@/sync/store/settings/acpCatalogSnapshot';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/** The existing catalog/cache owner, bound to the Action's captured Home/Account and Voice computer. */
export function createVoiceAgentSettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readAgentCatalog']> {
    return async (settings) => {
        if (!account) return null;
        account.assertCurrent();
        const { catalog } = await readAcpCatalogInContext(account);
        account.assertCurrent();
        if (catalog.status !== 'ready') return null;
        const state = storage.getState();
        const machineId = resolveVoiceExecutionMachineIdFromState({ ...state, settings });
        const params = { machineId, serverId: account.serverId, accountLifetime: account.accountLifetime };
        const projection = machineId ? await loadDaemonMergedProjectionCacheEntry({ ...params, machineId, reuseFreshReady: true }) : null;
        account.assertCurrent();
        const inputs = projection?.kind === 'ready' ? projection.inputs : null;
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSnapshot: catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: inputs?.discoveredBackendIds,
        }).filter(entry => entry.kind !== 'pluginBackend' || entry.agentCatalogEntry.identity !== null
            && entry.agentCatalogEntry.projectionGeneration !== null).map(entry => entry.agentCatalogEntry);
        return {
            entries,
            isCurrent: (current) => {
                const cached = inputs && machineId ? readReusableDaemonMergedProjectionCacheEntry({ ...params, machineId }) : null;
                return account.accountLifetime.isCurrent()
                    && isAcpCatalogCaptureCurrent(account.accountLifetime.scope, catalog)
                    && areAccountSettingsJsonValuesEqual(current.voice.executionMachine, settings.voice.executionMachine)
                    && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                    && (!inputs || cached?.kind === 'ready' && cached.inputs === inputs);
            },
        };
    };
}
