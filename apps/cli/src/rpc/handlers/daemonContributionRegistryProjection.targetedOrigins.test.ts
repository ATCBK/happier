import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

describe('targeted detail execution origins through admitted runtime publication', () => {
    it('mounts a real source-backed GitHub detail and diagnoses a dropped runtime materialization reader', async () => {
        const pluginId = 'happier.scm.forge.github';
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: {
                pluginIds: ['happier.triage', pluginId],
                resolveCurrentMachineId: () => 'machine-detail',
            },
        });
        try {
            // Real source admission and Availability produce this observation;
            // no copied execution-origin or targeted-snapshot fixture is used.
            expect(fixture.registry.contributes.materializationIdsByPluginId?.[pluginId]).toBeUndefined();
            const materialization = fixture.registry.readReleaseLessMaterializations?.()
                .find((entry) => entry.pluginId === pluginId);
            expect(materialization).toBeDefined();
            expect(materialization).toMatchObject({ enabled: true, trustState: 'trusted' });
            expect(fixture.registry.readPluginOccurrenceId?.(pluginId)).toBeTruthy();
            if (!materialization) throw new Error('Expected source-backed Availability materialization');
            const expectedOrigin = PluginMachineExecutionOriginV1Schema.parse({
                serverIdentityId: 'srv_detail',
                sourceRef: {
                    machineId: 'machine-detail', pluginId: materialization.pluginId,
                    sourceCustody: fixture.registry.readPluginSourceCustody?.(pluginId),
                },
            });

            const read = async (runtime: ResolvedExecutablePluginRuntimeRegistry, contextAvailable = true) => {
                invalidateDaemonContributionRegistryProjectionCache();
                const handlers = new Map<string, RpcHandler>();
                const registrar: RpcHandlerRegistrar = {
                    registerHandler(method, handler) { handlers.set(method, handler); },
                };
                registerDaemonContributionRegistryProjectionHandler(registrar, {
                    resolveRuntimeRegistry: async () => runtime,
                    resolveInstalledPackages: async () => [],
                    resolvePluginProjectionExecutionOriginContext: () => contextAvailable
                        ? { serverIdentityId: expectedOrigin.serverIdentityId, machineId: 'machine-detail' }
                        : null,
                });
                const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
                if (!handler) throw new Error('Expected real targeted-contributions RPC registration');
                return DaemonPluginUiTargetedContributionsReadResponseSchema.parse(await handler({
                    machineId: 'machine-detail', pluginId: 'happier.triage',
                }));
            };

            const response = await read(fixture.registry);
            expect(response.status).toBe('current');
            if (response.status !== 'current') throw new Error(`Detail projection refused: ${response.code}`);
            const mount = response.targetedSurfaceMounts.find((entry) => entry.contributor.pluginId === pluginId);
            expect(mount).toMatchObject({
                role: 'detail',
                executionOrigin: expectedOrigin,
                selectedRenderer: {
                    renderer: { kind: 'reactNative' },
                    artifactProjection: { pluginId },
                },
            });
            expect(response.targetedSurfaceMounts.length).toBeGreaterThan(0);

            // The real describe is cold and held at its filesystem catalog
            // boundary. Reading this admitted target must not join that work.
            invalidateDaemonContributionRegistryProjectionCache();
            let releaseCatalog!: () => void;
            let catalogEntered!: () => void;
            const pendingCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
            const enteredCatalog = new Promise<void>((resolve) => { catalogEntered = resolve; });
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({
                registerHandler(method, handler) { handlers.set(method, handler); },
            }, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => {
                    catalogEntered();
                    await pendingCatalog;
                    return [];
                },
                resolvePluginProjectionExecutionOriginContext: () => ({
                    serverIdentityId: expectedOrigin.serverIdentityId, machineId: 'machine-detail',
                }),
            });
            const describeHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const targetHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
            if (!describeHandler || !targetHandler) throw new Error('Expected registered projection handlers');
            const pendingDescribe = describeHandler({ machineId: 'machine-detail' });
            await enteredCatalog;
            let independentTarget: unknown;
            const pendingTarget = Promise.resolve(targetHandler({
                machineId: 'machine-detail', pluginId: 'happier.triage',
            })).then((result) => { independentTarget = result; });
            try {
                await vi.waitFor(() => {
                    expect(independentTarget).toEqual(response);
                });
            } finally {
                releaseCatalog();
                await Promise.all([pendingDescribe, pendingTarget]);
            }

            // The loaded pre-migration daemon copied flat stamps into this
            // artifact. Current strict consumers reject that producer shape;
            // the materialization arm itself remains a valid origin.
            const artifact = mount?.selectedRenderer.artifactProjection;
            if (!artifact) throw new Error('Expected real selected renderer artifact');
            const { executionOrigin: _origin, ...artifactDeclaration } = artifact;
            expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({
                ...response,
                targetedSurfaceMounts: response.targetedSurfaceMounts.map(entry => entry === mount ? {
                    ...entry, selectedRenderer: { ...entry.selectedRenderer, artifactProjection: {
                        ...artifactDeclaration, serverIdentityId: expectedOrigin.serverIdentityId,
                        materializationRef: { machineId: 'machine-detail', pluginId,
                            materializationId: materialization.materializationId },
                    } },
                } : entry),
            }).success).toBe(false);

            // Deliberate wiring mutation: dropping the real producer's reader
            // must refuse observably rather than publish handles with no mounts.
            expect(await read({ ...fixture.registry, readReleaseLessMaterializations: undefined })).toEqual({
                status: 'unavailable', code: 'plugin_targeted_surface_mount_unavailable',
            });
            expect(await read({ ...fixture.registry, readPluginSourceCustody: undefined })).toEqual({
                status: 'unavailable', code: 'plugin_targeted_contributions_unavailable',
            });
            expect(await read(fixture.registry, false)).toEqual({
                status: 'unavailable', code: 'plugin_targeted_surface_mount_unavailable',
            });
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await fixture.dispose();
        }
    }, 120_000);
});
