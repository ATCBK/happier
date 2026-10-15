import { describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createVoiceSettingsOwner } from '@happier-dev/protocol/voice/settings/voiceSettings';
import { createCliSettingsCatalogServices, projectCliProviderStateSharingRiskAgentIdsV1 } from './settingsCatalogServices';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { getAgentCore, isBundledAgentId } from '@happier-dev/agents';
import { readProviderStateSharingRiskAgentIdsV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { encodeScmDiffSummaryModelOverride, scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS, type ScmDiffSummaryCatalogProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot,
    commitActiveConnectedAccountCatalog, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedAccountCatalogRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmDiffSummaryModelCatalogObservationV1Schema, resolveScmDiffSummaryDefaultModelProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createCliActionDeps } from './createCliActionDeps';

describe('exact remote Voice Agent catalog admission', () => {
    it('offers executable automatic models from native sign-in and the canonical connected default', async () => {
        const home = createTempDirSync('summary-native-catalog-');
        const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        writeExecutableShimSync({ dir: home, fileName,
            contents: process.platform === 'win32'
                ? '@echo off\r\nif defined ANTHROPIC_API_KEY (echo {"loggedIn":true}& exit /b 0)\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
                : '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true}\'; exit 0; fi\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        for (const key of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('ANTHROPIC_API_KEY', undefined);
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
        const previous = getActiveAccountSettingsSnapshot();
        try {
            const services = createCliSettingsCatalogServices({});
            // Only Claude's native executable/auth is supplied by this OS
            // fixture; ambient worker Agent installations are not test input.
            const settings = accountSettingsParse({ backendEnabledByTargetKey: Object.fromEntries(
                [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
                    ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === 'claude']) : []),
            ) });
            const isClaude = (profile: ScmDiffSummaryCatalogProfile) =>
                profile.modelSelector?.backendTargetKey === 'agent:happier.agent.claude/claude';
            const credentials = { token: 'summary-connected-route-fixture', encryption: null };
            setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
                settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
            const observeActionCatalog = async (connected = false) => {
                const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, ...(connected ? { credentials } : {}),
                    sessionId: 'cli-global', mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
                        machineId: 'summary-machine', invoke: async () => { throw new Error('Unexpected catalogue transport recursion'); },
                    } }));
                expect(await executor.execute('agents.models.list', { machineId: 'another-machine', purpose: 'scm_diff_summary' },
                    { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: { source: 'unavailable' } });
                const result = await executor.execute('agents.models.list', { machineId: 'summary-machine', purpose: 'scm_diff_summary' },
                    { surface: 'cli', authority: 'present_user' });
                expect(result.ok, JSON.stringify(result)).toBe(true);
                if (!result.ok) throw new Error(JSON.stringify(result));
                getActionSpec('agents.models.list').outputSchema.parse(result.result);
                if (!result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing machine catalog');
                return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog).profiles;
            };
            expect(await probeAgentSignInStatus('claude')).toMatchObject({ status: 'signedOut' });
            const signedOut = await services.readScmDiffSummaryCatalog!(settings, '');
            expect(signedOut?.profiles.filter(isClaude)).toEqual([]);
            const signedOutObservation = await observeActionCatalog();
            expect(signedOutObservation).toEqual(signedOut?.profiles);
            expect(resolveScmDiffSummaryDefaultModelProfile(signedOutObservation)).toBeNull();
            const purpose = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
                contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(declaration =>
                    declaration.serviceRefs.some(service => service.localId === 'claude-subscription'));
            if (!purpose?.serviceRefs[0]) throw new Error('Claude connected route declaration is unavailable');
            expect(commitActiveConnectedAccountCatalog({ scopeKey: resolveAccountSettingsScopeKey(credentials),
                lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), key: 'purposes', catalog: { status: 'ready', revision: 1,
                    record: ConnectedAccountCatalogRecordV1Schema.parse({ key: 'purposes', value: { v: 1, bindings: [{
                        purpose: purpose.purpose, target: { kind: 'account', account: { service: purpose.serviceRefs[0], accountId: 'connected-summary' } },
                    }] } }) },
            })).toBe(true);
            const connected = await createCliSettingsCatalogServices({ credentials }).readScmDiffSummaryCatalog!(settings, '');
            expect(connected?.profiles.some(profile => isClaude(profile) && profile.costTier === 'low'
                && profile.structuredOutput === 'supported'), JSON.stringify({ profiles: connected?.profiles,
                    current: connected?.isCurrent(settings), purposeStatus: getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog?.status })).toBe(true);
            const connectedObservation = await observeActionCatalog(true);
            expect(connectedObservation).toEqual(connected?.profiles);
            expect(resolveScmDiffSummaryDefaultModelProfile(connectedObservation)).toMatchObject({ costTier: 'low', structuredOutput: 'supported' });
            vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key');
            expect(await probeAgentSignInStatus('claude')).toMatchObject({ status: 'signedIn' });
            const signedIn = await services.readScmDiffSummaryCatalog!(settings, '');
            expect(signedIn?.profiles.some(profile => isClaude(profile) && profile.structuredOutput === 'supported')).toBe(true);
            expect(signedIn?.profiles.some(profile => isClaude(profile) && profile.costTier === 'low'
                && profile.structuredOutput === 'supported')).toBe(true);
            expect(await observeActionCatalog()).toEqual(signedIn?.profiles);
            const binding = scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
            const prepared = await binding.prepare(settings, true, services);
            expect(prepared?.(settings)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true });
            expect(settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
            vi.unstubAllEnvs();
            removeTempDirSync(home);
        }
    });
    it('enumerates an admitted external Agent for an unset summary model without persisted identity resolution', async () => {
        const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.summary-catalog', contributes: {
                agents: [{ id: 'claude', title: 'External Agent', primary: 'executionRuns', runtime: { kind: 'custom' },
                    capabilities: { executionRuns: { open: ['create'], stop: true, checkpoint: false },
                        structuredOutput: { formats: ['json'] } } }],
            } }), files: {
                'daemon.mjs': `export function createAgent() { throw new Error('Catalog enumeration must not execute an Agent'); }
                    export function activate(api) {
                        api.agents.register('claude', createAgent, { sessionRunnerFactory: {
                            module: './daemon.mjs', export: 'createAgent', runtimeApiVersion: 1
                        } });
                    }`,
            } }],
        });
        try {
            const external = [...readCurrentContributionRegistry().agentDefinitionsById.values()]
                .find(entry => entry.identity?.pluginId === 'acme.summary-catalog');
            expect(external?.id).toBe('acme.summary-catalog/claude');
            const settings = accountSettingsParse({});
            const catalog = await createCliSettingsCatalogServices({}).readScmDiffSummaryCatalog!(settings, '');
            expect(catalog).not.toBeNull();
            expect(catalog?.isCurrent(settings)).toBe(true);
            expect(settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
        } finally {
            await admitted.dispose();
        }
    });
    it('refuses an unknown model target without treating the Custom ACP declaration as executable', async () => {
        expect([...readCurrentContributionRegistry().agentDefinitionsById.values()].some(entry => entry.id === 'custom-acp')).toBe(true);
        const services = createCliSettingsCatalogServices({});
        await expect(services.readScmDiffSummaryCatalog!(accountSettingsParse({}), encodeScmDiffSummaryModelOverride({
            backendTargetKey: 'agent:missing.agent/missing', modelId: 'model',
        }))).resolves.toBeNull();
    });
    it('distinguishes an unactivated empty snapshot from a proven activated empty native catalog', () => {
        const empty = createResolvedContributionRegistry({});
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: false, unavailable: false })).toBeNull();
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: false })).toEqual([]);
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: true })).toBeNull();
    });
    it('derives named sharing risks only from genuine current bundled capabilities', () => {
        const entries = [...readCurrentContributionRegistry().agentDefinitionsById.values()];
        const services = createCliSettingsCatalogServices({});
        if (entries.some(entry => entry.provenance !== 'first_party' || !isBundledAgentId(entry.id))) {
            expect(services.readProviderStateSharingRiskAgentIds()).toBeNull();
        } else {
            const risks = readProviderStateSharingRiskAgentIdsV1(entries.map(entry => ({ agentId: entry.id,
                capability: isBundledAgentId(entry.id) ? getAgentCore(entry.id).connectedServices?.providerStateSharing : null,
            })));
            expect(services.readProviderStateSharingRiskAgentIds()).toEqual(risks);
            expect(risks).toContain('codex');
        }
    });
    it('uses the selected remote routing tuple and refuses its captured proof after a real projection generation change', async () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const settings = { ...accountSettingsParse({}), voice: {
            ...owner.voiceSettingsDefaults, executionMachine: { mode: 'fixed' as const, machineId: 'remote-computer' },
        } };
        let generation = 7;
        const services = createCliSettingsCatalogServices({ credentials: { token: 'fixture', encryption: null },
            serverId: 'server', expectedAccountId: 'account', voiceOwner: owner,
            // The machine RPC is the external boundary; projection parsing and selection remain real.
            readMachineAgentProjection: async machineId => machineId === 'remote-computer'
                ? PluginProjectionV2Schema.parse({ v: 2, generation, familiesById: {}, agentsById: {
                    remote: { id: 'remote-routing-id', identity: { pluginId: 'acme.agent', localId: 'remote' }, isBuiltIn: false },
                } }) : null,
        });
        const catalog = await services.readAgentCatalog!(settings);
        expect(catalog?.entries).toEqual([{ agentId: 'remote-routing-id', backendTargetKey: 'agent:acme.agent/remote',
            identity: { pluginId: 'acme.agent', localId: 'remote' }, projectionGeneration: 7, isBuiltIn: false, enabled: true }]);
        expect(catalog?.isCurrent({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'fixed', machineId: 'other-computer' } } })).toBe(false);
        expect(await services.isCurrent()).toBe(true);
        generation = 8;
        expect(await services.isCurrent()).toBe(false);
        expect(await services.readAgentCatalog!({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'auto', machineId: null } } })).toBeNull();
    });
});
