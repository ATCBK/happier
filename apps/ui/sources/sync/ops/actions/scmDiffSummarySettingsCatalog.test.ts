import { describe, expect, it, onTestFinished } from 'vitest';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, RPC_METHODS } from '@happier-dev/protocol';
import { scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture } from '@/dev/testkit';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { resetDynamicModelProbeCacheForTests, writeDynamicModelProbeCacheSuccess } from '@/sync/domains/models/dynamicModelProbeCache';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

async function catalogAccount(catalogAvailable = true) {
    const network = await installSessionOpsNetworkBoundary();
    onTestFinished(() => network.dispose());
    const home = await network.addHome('https://summary-settings.example.test', 'summary-account');
    await setServerProfileIdentityForUrl(home.serverUrl, 'srv_summary_settings');
    network.setHttpResponder(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return catalogAvailable
            ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } })
            : new Response(null, { status: 503 });
        return null;
    });
    const account = await captureLazyActionAccountContext(home.id);
    onTestFinished(() => account.dispose());
    return { account, home, network };
}

describe('Summary settings catalog admission', () => {
    it('admits an unset low-cost default for prefetch without persisting a model override', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        storage.setState({ settings: settingsDefaults });
        const { account } = await catalogAccount(false);
        const reader = createScmDiffSummarySettingsCatalogReader(account);
        const catalog = await reader(settingsDefaults, '');
        expect(catalog?.profiles.some(profile => profile.costTier === 'low' && profile.structuredOutput === 'supported')).toBe(true);
        const binding = scmDiffSummarySettingBinding<typeof settingsDefaults>(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
        const prepared = await binding.prepare(settingsDefaults, true, { readScmDiffSummaryCatalog: reader });
        expect(prepared?.(settingsDefaults)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true });
        expect(storage.getState().settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
    });
    it('reads real offered model support and rejects catalog authority after the selected Agent is disabled', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        storage.setState({ settings: settingsDefaults });
        const { account } = await catalogAccount();
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }),
            backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey,
        });
        const choices = entries.flatMap(entry => buildScmDiffSummaryModelProfiles({
            backendTarget: readBackendTargetRefV2(entry.backendTarget),
            models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats,
        }));
        const offered = choices.find(profile => profile.structuredOutput === 'supported');
        if (!offered?.modelSelector?.backendTargetKey) throw new Error('Expected a genuinely supported bundled model');
        const reader = createScmDiffSummarySettingsCatalogReader(account);
        const catalog = await reader(settingsDefaults, offered.catalogId);
        expect(catalog?.profiles).toContainEqual(offered);
        expect(catalog?.isCurrent(settingsDefaults)).toBe(true);
        const disabled = { ...settingsDefaults, backendEnabledByTargetKey: {
            ...settingsDefaults.backendEnabledByTargetKey, [offered.modelSelector.backendTargetKey]: false,
        } };
        expect(catalog?.isCurrent(disabled)).toBe(false);
        expect(await reader(disabled, offered.catalogId)).toBeNull();
    });

    it('stores offered Haiku from the selected machine and withdraws admission when its model evidence changes', async () => {
        const before = storage.getState();
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const beforeApplied = runtime.getAppliedActiveServerSnapshot();
        const beforeAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        onTestFinished(() => {
            runtime.publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState(before, true);
            runtime.publishAppliedActiveServerSnapshot(beforeApplied, beforeAvailable);
            resetDynamicModelProbeCacheForTests();
            clearDaemonMergedProjectionCacheForTests();
        });
        resetDynamicModelProbeCacheForTests();
        clearDaemonMergedProjectionCacheForTests();
        const { account, home, network } = await catalogAccount();
        const machine = createMachineFixture({ activeAt: Date.now() });
        const settings = { ...settingsDefaults, machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl]: { serverIdentityId: 'srv_summary_settings', machineId: machine.id },
        } };
        runtime.publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState({ settings, profileScope: account.accountLifetime.scope, isDataReady: true, machines: { [machine.id]: machine },
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        runtime.publishAppliedActiveServerSnapshot({ serverId: account.serverId, serverUrl: home.serverUrl,
            generation: beforeApplied.generation + 1 });
        expect(resolveFreshMachineAdministrationExecutionTarget(settings.machineAdministrationTargetsLocalV1[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl])?.machine.id).toBe(machine.id);
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection: {
            v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, toolsById: {},
            commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
        } });
        const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(settings),
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey }).find(candidate => candidate.agentId === 'claude');
        if (!entry) throw new Error('Expected bundled Claude');
        const target = readBackendTargetRefV2(entry.backendTarget);
        const models = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: target, models,
            agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats });
        const offered = profiles.find(profile => profile.modelSelector?.modelId === 'claude-haiku-4-5');
        if (!offered || offered.structuredOutput !== 'supported') throw new Error('Expected offered supported Haiku');
        const cacheKey = buildDynamicModelProbeCacheKey({ machineId: machine.id, targetKey: buildBackendTargetKeyV2(target),
            serverId: account.serverId, providerConnectionId: null });
        if (!cacheKey) throw new Error('Expected selected-machine model cache key');
        writeDynamicModelProbeCacheSuccess(cacheKey, { availableModels: [...models], supportsFreeform: true });
        const reader = createScmDiffSummarySettingsCatalogReader(account);
        const binding = scmDiffSummarySettingBinding<typeof settings>(SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride);
        const prepared = await binding.prepare(settings, offered.catalogId, { readScmDiffSummaryCatalog: reader });
        const delta = prepared?.(settings);
        expect(delta).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: offered.catalogId });
        storage.setState({ settings: { ...settings, ...delta } });
        expect(storage.getState().settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe(offered.catalogId);
        writeDynamicModelProbeCacheSuccess(cacheKey, { availableModels: models.map(model => ({ ...model,
            capabilities: { ...model.capabilities, structuredOutput: 'unsupported' as const } })), supportsFreeform: true });
        expect(prepared?.(settings)).toBeNull();
        expect(await binding.prepare(settings, offered.catalogId, { readScmDiffSummaryCatalog: reader })).toBeNull();
    });

    it('keeps bundled model admission independent of an unavailable configured-ACP catalog', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        storage.setState({ settings: settingsDefaults });
        const { account } = await catalogAccount(false);
        const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(settingsDefaults),
            backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey }).find(candidate => candidate.agentId === 'claude');
        if (!entry) throw new Error('Expected bundled Claude');
        const offered = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(entry.backendTarget),
            models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats }).find(profile => profile.structuredOutput === 'supported');
        if (!offered) throw new Error('Expected supported bundled model');
        const catalog = await createScmDiffSummarySettingsCatalogReader(account)(settingsDefaults, offered.catalogId);
        expect(catalog).not.toBeNull();
        expect(catalog?.profiles).toContainEqual(offered);
        expect(catalog?.isCurrent(settingsDefaults)).toBe(true);
    });
});
