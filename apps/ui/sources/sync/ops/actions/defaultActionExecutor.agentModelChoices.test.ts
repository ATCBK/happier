import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { LlmTaskRunnerConfigV1WriteSchema } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { projectAgentModelChoices } from '@/components/settings/pickers/projectAgentModelChoices';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';

// Native/browser storage and Home HTTP are boundaries; picker, declarations,
// default executor, Account mutation/CAS and strict Run admission stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installDisconnectedServerSocketBoundary();
// Warm the real runtime import graph during collection, as the composed picker
// harnesses do. Per-test time belongs to the HTTP/CAS journey, not module loading.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('background model selection through Account Settings Actions', () => {
    it.each(['agent', 'mcp'] as const)('persists the shared picker selection for both anchors on %s', async surface => {
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(settingsDefaults),
            backendEnabledByTargetKey: settingsDefaults.backendEnabledByTargetKey });
        const profiles = entries.flatMap(entry => buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(entry.backendTarget),
            models: getAgentStaticModels(entry.agentId, { catalogOnly: true }), agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats }));
        const choices = projectAgentModelChoices({ purpose: 'walkthrough', defaultModelTitle: 'Default',
            executableProfiles: profiles, automaticProfiles: profiles,
            sources: entries.map(entry => ({ entry, models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
                catalogModels: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
                agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats, runnerCapable: true, discoverable: false })) });
        const choice = choices.defaultProfile && choices.selections.get(choices.defaultProfile.catalogId);
        if (!choice) throw new Error('Expected a real supported model from the shared picker');
        const summary = choices.defaultProfile!.catalogId;
        const runner = LlmTaskRunnerConfigV1WriteSchema.parse({ v: 1, modelSelection: choice.modelSelection, permissionMode: 'no_tools' });
        const machine = createMachineFixture({ id: 'model-machine', activeAt: Date.now() });
        const serverUrl = `https://background-models-${surface}.test`;
        const serverIdentityId = `srv_background_models_${surface}`;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'model-account',
            machineId: machine.id, actionId: 'agents.models.list', tokenEpoch: 0,
            execute: input => {
                expect(input).toMatchObject({ purpose: 'scm_diff_summary', machineId: machine.id,
                    modelSelector: choice.modelSelector });
                return { items: [], scmDiffSummaryCatalog: { profiles, automaticProfiles: profiles, discoveryTargetKeys: profiles.flatMap(profile => profile.modelSelector?.backendTargetKey ?? []) } };
            } });
        const accountSettings = settingsParse({ machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl]: { serverIdentityId, machineId: machine.id } },
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
            approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] } }) });
        const home = await serveActionHomes({ homes: [{ key: 'models', serverUrl,
            serverIdentityId, accountId: 'model-account', currentAccount: true,
            settings: accountSettings }], route: async request => {
                const external = await boundary.handle(request.url, { method: request.method,
                    ...(request.method !== 'GET' ? { body: JSON.stringify(request.body) } : {}) });
                if (external) return external;
                if (request.path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { v: 1, definitions: [] } } });
                if (request.path === '/v1/features/authenticated' || request.path === '/v1/features')
                    return Response.json(createRootLayoutFeaturesResponse());
                return undefined;
            } });
        try {
            const address = home.homes.models!;
            const { getStorage } = await import('@/sync/domains/state/storage');
            // Hydrate the served Account through its real owner before policy admission.
            // A disconnected Socket cannot deliver bootstrap Settings to the live projection.
            getStorage().getState().applySettingsForScope({ serverId: address.id, accountId: 'model-account' }, accountSettings, 1);
            getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [address.id]: [machine] },
                machineListStatusByServerId: { [address.id]: 'idle' } });
            const executor = createDefaultActionExecutor();
            const context = { surface, authority: 'account_automation' as const, serverId: address.id, expectedAccountId: 'model-account' };
            for (const [anchor, value] of [['sourceControl.summaryModel', summary], ['session.resume.summaryModel', runner]] as const) {
                expect(await executor.execute('settings.set', { anchor, value }, context)).toEqual({ ok: true, result: { anchor, value } });
                expect(await executor.execute('settings.get', { anchor }, context)).toEqual({ ok: true, result: { anchor, value } });
            }
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = await TokenStorage.getCredentialsForServerUrl(address.serverUrl);
            if (!credentials) throw new Error('Fixture Account credential was retired');
            const response = await runtimeFetch(`${address.serverUrl}/v2/account/settings`, {
                headers: { Authorization: `Bearer ${credentials.token}` },
            });
            const snapshot = AccountSettingsV2GetResponseSchema.parse(await response.json());
            expect(snapshot.version).toBeGreaterThan(1);
            if (snapshot.content?.t !== 'plain') throw new Error('Expected the persisted plain Account envelope');
            const stored = settingsParse(snapshot.content.v);
            expect(stored['scm.diffSummary.modelProfileOverride']).toBe(summary);
            expect(stored.sessionReplaySummaryRunnerV1).toEqual(runner);
            expect(JSON.parse(stored['scm.diffSummary.modelProfileOverride'].slice('model:'.length))).toEqual(runner.modelSelection);
            const request = ExecutionRunStartRequestSchema.parse({ intent: 'task', backendTarget: readBackendTargetRefV2(runner.modelSelection.agentTargetKey),
                modelSelection: stored.sessionReplaySummaryRunnerV1!.modelSelection, permissionMode: 'no_tools',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', instructions: 'Summarize the conversation' });
            expect(request.modelSelection).toEqual(choice.modelSelection);
        } finally { await home.dispose(); }
    });
});
