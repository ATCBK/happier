import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeTextFileSync } from '@/testkit/fs/fileHelpers';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { accountSettingsParse, isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1, listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

describe('Summary native model discovery', () => {
    it('discovers a new native model through the public Summary Action while retaining automatic default evidence', async () => {
        const requests: string[] = [];
        const home = createTempDirSync('summary-native-discovery-');
        const modelFile = join(home, 'models.json');
        writeTextFileSync(modelFile, JSON.stringify([{ id: 'initial-model', displayName: 'Initial model', isDefault: true }]));
        const script = writeAcpTestAgentScript({ dir: home, fileName: 'native-catalog.cjs', source: `
            if (process.argv[2] === 'login') process.exit(0);
            if (process.argv[2] === '--version') { console.log('codex-cli 1.0.0'); process.exit(0); }
            let buffer = '';
            process.stdin.on('data', chunk => {
                buffer += chunk.toString(); const lines = buffer.split('\\n'); buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const request = JSON.parse(line);
                    if (request.id === undefined) continue;
                    const result = request.method === 'model/list'
                        ? { data: JSON.parse(require('node:fs').readFileSync(${JSON.stringify(modelFile)}, 'utf8')) }
                        : request.method === 'collaborationMode/list' ? { data: [] } : {};
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
                }
            });
        ` });
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({ dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
            contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
        for (const key of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CODEX_PATH', executable);
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        const previous = getActiveAccountSettingsSnapshot();
        let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        try {
            admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.custom-acp'],
                // Account persistence is the real external boundary; an empty
                // record lets native plugin Settings resolve without live credentials.
                accountSettingsRecordAdapter: { bindOperation: async () => ({
                    readRecord: async () => ({ status: 'absent' }), writeRecord: async () => ({ status: 'unavailable' }),
                }) },
            } });
            resetAgentModelsProbeCacheForTests();
            expect([...readCurrentContributionRegistry().agentDefinitionsById.values()].some(entry => isCustomAcpAgentContributionIdentityV1(entry.identity)),
                JSON.stringify({ agents: [...readCurrentContributionRegistry().agentDefinitionsById.values()].map(entry => ({ id: entry.id, identity: entry.identity })),
                    diagnostics: admitted.registry.pluginDiagnosticsByPluginId['happier.agent.custom-acp'] })).toBe(true);
            const configuredTargetKey = buildBackendTargetKeyV2(listAgentExecutionTargetsV1(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, ['missing-configured-agent'])[0]!);
            const rawSettings = { backendEnabledByTargetKey: { ...Object.fromEntries(
                [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
                    ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === 'codex']) : [])),
                [configuredTargetKey]: true } };
            const settings = accountSettingsParse(rawSettings);
            expect(isBackendTargetDisabledByAccountSettings(settings, configuredTargetKey)).toBe(false);
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'native-summary-account', tokenEpoch: 0 })).toString('base64url')}.signature`,
                encryption: null, credentialProvenance: 'stored_session' as const };
            const acpCatalog = { status: 'ready' as const, revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
                id: 'missing-configured-agent', name: 'missing-configured-agent', title: 'Missing Agent',
                launch: { kind: 'command' as const, command: join(home, 'absent-agent'), args: [] }, env: {},
                capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'yes' as const,
                    supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const }, createdAt: 1, updatedAt: 1,
            }] }) };
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings, settingsVersion: 1,
                scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [], acpCatalog });
            // Exercise the actual CLI factory: it creates invocation Account custody
            // from bootstrap, rather than a test-created operation context.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                requests.push(path);
                if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: rawSettings } } };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
                    content: { t: 'plain', v: acpCatalog.record } } };
                if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200, data: { status: 'present', revision: 1,
                    content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') } } };
                if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
                return { status: 404, data: {} };
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                pluginActionExecutionOwner: 'current_process',
                machineActionDirectTargetTransport: { machineId: 'native-model-machine', invoke: async () => { throw new Error('Unexpected recursion'); } } });
            const observe = async (discover = false) => {
                const result = await executor.execute('agents.models.list', { purpose: 'scm_diff_summary', machineId: 'native-model-machine',
                    ...(discover ? { discoveryTargetKey: 'agent:happier.agent.codex/codex' } : {}) }, { surface: 'cli', authority: 'present_user' });
                expect(result).toMatchObject({ ok: true });
                if (!result.ok || !result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing native catalog');
                return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
            };
            const initial = await observe();
            expect(initial).toMatchObject({ probeFailures: [{ backendTargetKey: configuredTargetKey,
                spawnFailure: { reason: 'other', errno: 'ENOENT' } }] });
            expect(JSON.stringify(initial)).not.toContain(join(home, 'absent-agent'));
            expect(initial.profiles, JSON.stringify({ initial,
                requests,
                purpose: getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog?.status,
                agents: [...readCurrentContributionRegistry().agentDefinitionsById.keys()] })).toEqual(expect.arrayContaining([expect.objectContaining({ modelSelector: {
                backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'initial-model' }, structuredOutput: 'supported' })]));
            writeTextFileSync(modelFile, JSON.stringify([{ id: 'discovered-model', displayName: 'Discovered model', isDefault: true }]));
            expect((await observe()).profiles).toEqual(initial.profiles);
            const discovered = await observe(true);
            expect(discovered.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ modelSelector: {
                backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'discovered-model' }, structuredOutput: 'supported' })]));
            expect(discovered.automaticProfiles).toEqual(initial.automaticProfiles);
            // Consume the real producer's strict observation in the App's
            // pure picker, following the existing cross-App harness convention.
            const picker: { projectAgentModelChoices(input: Readonly<{ purpose: 'walkthrough'; sources: readonly unknown[];
                executableProfiles: typeof discovered.profiles; automaticProfiles: typeof discovered.automaticProfiles;
                discoveryTargetKeys: readonly string[]; defaultModelTitle: string }>): Readonly<{ selections: Map<string, unknown>; defaultProfile: unknown }> }
                = await import(new URL('../../../../ui/sources/components/settings/pickers/projectAgentModelChoices.ts', import.meta.url).href);
            const projected = picker.projectAgentModelChoices({ purpose: 'walkthrough', sources: [{
                entry: { kind: 'builtInAgent', backendTarget: 'agent:happier.agent.codex/codex', agentId: 'codex', title: 'Codex' },
                models: [], catalogModels: [], runnerCapable: true, discoverable: true,
            }], executableProfiles: discovered.profiles, automaticProfiles: discovered.automaticProfiles,
                discoveryTargetKeys: discovered.discoveryTargetKeys, defaultModelTitle: 'Default' });
            expect([...projected.selections.keys()]).toContain(discovered.profiles.find(profile => profile.modelSelector?.modelId === 'discovered-model')?.catalogId);
        } finally {
            await admitted?.dispose();
            resetAgentModelsProbeCacheForTests();
            vi.restoreAllMocks();
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
            vi.unstubAllEnvs(); removeTempDirSync(home);
        }
    });
});
