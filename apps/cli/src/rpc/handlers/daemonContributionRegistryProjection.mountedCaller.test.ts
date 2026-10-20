import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { DaemonPluginMountedInvocationV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('mounted caller admission through the real contributed Action RPC', () => {
    it('admits an ordinary installed external detail contributor through the same RPC and rejects retired custody', async () => {
        const targetId = 'acme.detail-host';
        const contributorId = 'acme.detail-source';
        const protocol = { id: 'detail', version: 1 } as const;
        const target = definePlugin({
            id: targetId, version: '1.0.0', displayName: 'External detail host',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] },
            contributionPoints: { details: defineContributionProtocol({
                ...protocol,
                operations: {},
                surfaces: { detail: { required: true, presentation: 'content',
                    inputSchema: defineProtocolObject({}, { policy: 'closed' }) } },
            }).point() },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: target.manifest, files: {} }, {
                manifest: createPluginManifestV2Fixture({ id: contributorId, contributes: {
                    actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], dangerLevel: 'safe', execution: { target: 'daemon' },
                        inputSchema: { type: 'object', additionalProperties: false },
                        resultSchema: { type: 'object', additionalProperties: true } }],
                    ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Detail' } }] },
                    composerRegions: [{ id: 'composer-detail', placement: 'beforeComposer', renderer: { renderer: 'detail' } }],
                    composerAttachments: [{ id: 'headless-attachment', title: 'Reference', icon: 'file', cardinality: 'many', valueSchema: { type: 'object' } }],
                    targetedPluginContributions: [{ id: 'source', target: { pluginId: targetId, pointId: 'details' },
                        protocol, operations: {}, surfaces: { detail: { renderer: 'detail' } } }],
                } }),
                files: { 'daemon.mjs': "export function activate(api) { api.actions.register('read', (_input, context) => context.caller); }" },
            }],
            runtimeOptions: { resolveCurrentMachineId: () => 'external-machine' },
        });
        const stages = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_external-home', machineId: 'external-machine' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('Expected contributed Action RPC');
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(contributorId);
            const sourceCustody = fixture.registry.readPluginSourceCustody?.(contributorId);
            const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(contributorId);
            if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected installed external source');
            expect(sourceCustody.kind).toBe('managed');
            const mountedBinding = { pluginId: contributorId, contributionLocalId: 'source', occurrenceId, sourceCustody, materializationRef };
            const run = async (contributionLocalId = 'source') => DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({
                machineId: 'external-machine', qualifiedActionId: `${contributorId}/read`, expectedContributorOccurrenceId: occurrenceId,
                input: {}, executionSurface: 'ui', invocation: { kind: 'mountedPluginSurface', mountedBinding: { ...mountedBinding, contributionLocalId } },
            }, { signal: new AbortController().signal, transportRequestId: `rpc_${requestId}` }));
            for (const contributionLocalId of ['source', 'composer-detail']) {
                expect(await run(contributionLocalId)).toEqual({ ok: true, result: {
                    kind: 'plugin', pluginId: contributorId, contribution: { id: contributionLocalId, qualifiedId: `${contributorId}/${contributionLocalId}` },
                    occurrenceId, sourceCustody, materialization: materializationRef,
                    executionOrigin: { serverIdentityId: 'srv_external-home', materializationRef }, originSurface: 'ui',
                } });
            }
            const recorded = stages.mock.calls.filter(([message]) => message === '[external-action-stage]');
            for (const stage of ['contributed.runtime_lease', 'contributed.mounted_caller', 'contributed.mounted_origin',
                'contributed.execute', 'contributed.target_invoke']) {
                expect(recorded).toEqual(expect.arrayContaining(['begin', 'end'].map(edge => [
                    '[external-action-stage]', expect.objectContaining({ actionId: 'action.invoke', rootRequestId: requestId,
                        stage: `${stage}.${edge}` }),
                ])));
            }
            expect(await run('headless-attachment')).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            fixture.registry.fencePluginConsumers?.([contributorId]);
            expect(await run()).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
        } finally { stages.mockRestore(); await fixture.dispose(); }
    });

    it('dispatches admitted client, voice, settings, Composer and targeted detail callers, refusing a daemon contribution masquerading as a client mount and retired custody', async () => {
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
            runtimeOptions: { pluginIds: ['acme.probe', 'happier.channels', 'happier.voice.openai', 'happier.triage', 'happier.scm.forge.github'],
                resolveCurrentMachineId: () => 'machine-1' },
        });
        try {
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
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
            const composer = fixture.registry.contributes.composerAttachments?.find((entry) => entry.pluginId === 'happier.triage');
            if (!voice || !settings || !composer) throw new Error('Expected real admitted Voice, settings-page and Composer declarations');
            const client = binding('acme.probe', 'client-select');
            const targeted = fixture.registry.contributes.targetedPluginContributions?.find((entry) => (
                entry.pluginId === 'happier.scm.forge.github' && entry.identity.localId === 'github-forge'
            ));
            if (!targeted) throw new Error('Expected real GitHub source declaration');
            const admitted = fixture.registry.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: targeted.definition.target.pluginId,
                pointId: targeted.definition.target.pointId,
                protocol: targeted.definition.protocol,
            });
            expect(admitted?.contributions.some(entry => entry.contributor.pluginId === targeted.pluginId
                && entry.contributor.contributionId === targeted.identity.localId
                && entry.surfaces.length > 0)).toBe(true);
            const invocations: DaemonPluginMountedInvocationV1[] = [
                { kind: 'clientPluginAction', clientActionBinding: client },
                { kind: 'mountedPluginSurface', mountedBinding: binding(voice.pluginId!, voice.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(settings.pluginId!, settings.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(targeted.pluginId!, targeted.identity.localId) },
                { kind: 'mountedPluginSurface', mountedBinding: binding(composer.pluginId!, composer.identity.localId) },
            ];
            const run = async (invocation: DaemonPluginMountedInvocationV1) => DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({
                machineId: 'machine-1', expectedContributorOccurrenceId: client.occurrenceId,
                qualifiedActionId: 'acme.probe/probe', input: {}, executionSurface: 'ui', invocation,
            }));
            for (const invocation of invocations) {
                const mounted = invocation.kind === 'clientPluginAction' ? invocation.clientActionBinding : invocation.mountedBinding;
                expect(await run(invocation)).toEqual({ ok: true, result: {
                    kind: 'plugin', pluginId: mounted.pluginId,
                    contribution: { id: mounted.contributionLocalId, qualifiedId: `${mounted.pluginId}/${mounted.contributionLocalId}` },
                    occurrenceId: mounted.occurrenceId, sourceCustody: mounted.sourceCustody,
                    materialization: mounted.materializationRef,
                    executionOrigin: { serverIdentityId: 'srv_home-1', materializationRef: mounted.materializationRef }, originSurface: 'ui',
                } });
            }
            expect(await run({ kind: 'clientPluginAction', clientActionBinding: { ...client, contributionLocalId: 'probe' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            const detail = binding(targeted.pluginId!, targeted.identity.localId);
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail, contributionLocalId: 'not-a-surface' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail, occurrenceId: 'github-retired' } }))
                .toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: { ...detail,
                sourceCustody: { kind: 'development', registeredRootId: '/retired-github-source' },
            } })).toEqual({ ok: false, code: 'plugin_mounted_caller_unavailable' });
            const headless = fixture.registry.contributes.targetedPluginContributions?.find((entry) => (
                entry.pluginId === targeted.pluginId && entry.definition.target.pluginId === 'happier.channels'
            ));
            if (!headless) throw new Error('Expected real headless GitHub conversation contribution');
            const headlessSnapshot = fixture.registry.contributes.readAdmittedTargetedContributions?.({
                targetPluginId: headless.definition.target.pluginId,
                pointId: headless.definition.target.pointId,
                protocol: headless.definition.protocol,
            });
            expect(headlessSnapshot?.contributions.find(entry => (
                entry.contributor.pluginId === headless.pluginId
                && entry.contributor.contributionId === headless.identity.localId
            ))?.surfaces).toEqual([]);
            expect(await run({ kind: 'mountedPluginSurface', mountedBinding: binding(headless.pluginId!, headless.identity.localId) }))
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
