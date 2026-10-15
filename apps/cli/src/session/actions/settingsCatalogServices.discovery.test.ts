import { describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeTextFileSync } from '@/testkit/fs/fileHelpers';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliActionDeps } from './createCliActionDeps';

describe('Summary native model discovery', () => {
    it('discovers a new native model through the public Summary Action while retaining automatic default evidence', async () => {
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
            admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex'],
                // Account persistence is the real external boundary; an empty
                // record lets native plugin Settings resolve without live credentials.
                accountSettingsRecordAdapter: { bindOperation: async () => ({
                    readRecord: async () => ({ status: 'absent' }), writeRecord: async () => ({ status: 'unavailable' }),
                }) },
            } });
            resetAgentModelsProbeCacheForTests();
            const settings = accountSettingsParse({});
            const credentials = { token: 'native-summary-discovery', encryption: null };
            const acpCatalog = { status: 'ready' as const, revision: 'absent' as const, record: { v: 1 as const, definitions: [] } };
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1,
                scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [], acpCatalog });
            const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, sessionId: 'native-summary', mode: 'plain', ctx: null,
                machineActionDirectTargetTransport: { machineId: 'native-model-machine', invoke: async () => { throw new Error('Unexpected recursion'); } } }));
            const observe = async (discover = false) => {
                const result = await executor.execute('agents.models.list', { purpose: 'scm_diff_summary', machineId: 'native-model-machine',
                    ...(discover ? { discoveryTargetKey: 'agent:happier.agent.codex/codex' } : {}) }, { surface: 'cli', authority: 'present_user' });
                expect(result).toMatchObject({ ok: true });
                if (!result.ok || !result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing native catalog');
                return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
            };
            expect(await probeAgentSignInStatus('codex')).toMatchObject({ status: 'signedIn' });
            const initial = await observe();
            expect(initial.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ modelSelector: {
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
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
            vi.unstubAllEnvs(); removeTempDirSync(home);
        }
    });
});
