import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { DaemonPluginMountedInvocationV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('mounted caller admission through the real contributed Action RPC', () => {
    it('dispatches admitted client, voice and settings callers, refusing a daemon contribution masquerading as a client mount and retired custody', async () => {
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{
                manifest: createPluginManifestV2Fixture({ id: 'acme.probe', contributes: {
                    actions: [{ id: 'probe', title: 'Read admitted caller', scopes: ['global'],
                        surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                        inputSchema: { type: 'object', additionalProperties: false },
                        resultSchema: { type: 'object', additionalProperties: true },
                        execution: { target: 'daemon' } },
                    { id: 'client-select', title: 'Select', scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], dangerLevel: 'safe', execution: { target: 'client',
                            client: { artifactId: 'select-ui', exportName: 'activate' }, platforms: ['web'] } }],
                } }),
                files: { 'daemon.mjs': "export function activate(api) { api.actions.register('probe', (_input, context) => context.caller); }" },
            }],
            runtimeOptions: { pluginIds: ['acme.probe', 'happier.channels', 'happier.voice.openai'],
                resolveCurrentMachineId: () => 'machine-1' },
        });
        try {
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'home-1', machineId: 'machine-1' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('Expected contributed Action RPC');
            const binding = (pluginId: string, contributionLocalId: string) => {
                const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
                const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
                const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId);
                if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected admitted mount');
                return { pluginId, contributionLocalId, occurrenceId, sourceCustody, materializationRef };
            };
            const voice = fixture.registry.contributes.voiceProviders?.find((entry) => entry.pluginId === 'happier.voice.openai');
            const settings = fixture.registry.contributes.uiSettingsPagesV2?.find((entry) => entry.pluginId === 'happier.channels');
            if (!voice || !settings) throw new Error('Expected real admitted Voice and settings-page declarations');
            const client = binding('acme.probe', 'client-select');
            const invocations: DaemonPluginMountedInvocationV1[] = [
                { kind: 'clientPluginAction', clientActionBinding: client },
                { kind: 'mountedPluginSurface', mountedBinding: binding(voice.pluginId!, voice.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(settings.pluginId!, settings.identity.localId) },
            ];
            const run = (invocation: DaemonPluginMountedInvocationV1) => handler({
                machineId: 'machine-1', expectedContributorOccurrenceId: client.occurrenceId,
                qualifiedActionId: 'acme.probe/probe', input: {}, executionSurface: 'ui', invocation,
            });
            for (const invocation of invocations) {
                const mounted = invocation.kind === 'clientPluginAction' ? invocation.clientActionBinding : invocation.mountedBinding;
                expect(await run(invocation)).toEqual({ ok: true, result: {
                    kind: 'plugin', pluginId: mounted.pluginId,
                    contribution: { id: mounted.contributionLocalId, qualifiedId: `${mounted.pluginId}/${mounted.contributionLocalId}` },
                    occurrenceId: mounted.occurrenceId, sourceCustody: mounted.sourceCustody,
                    materialization: mounted.materializationRef, originSurface: 'ui',
                } });
            }
            expect(await run({ kind: 'clientPluginAction', clientActionBinding: { ...client, contributionLocalId: 'probe' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'clientPluginAction', clientActionBinding: { ...client,
                materializationRef: { ...client.materializationRef, materializationId: 'retired-materialization' },
            } })).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            fixture.registry.fencePluginConsumers?.(['happier.channels']);
            expect(await run(invocations[2]!)).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
        } finally {
            await fixture.dispose();
        }
    });
});
