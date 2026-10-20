import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createRunnerExecutionRunProviderLaunchServices, projectRunnerExecutionRunProviderLaunch } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { admitExecutionRunInheritedProviderSelection, prepareExecutionRunProviderLaunch } from './providerLaunch';

describe('execution-run pinned Provider preparation', () => {
    it('uses the retained executable snapshot for admission and materialization without a runner daemon singleton', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        let endpointReleased = false;
        try {
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
            const input = {
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend' as const, backendId: fixture.agentId },
                agentId: fixture.agentId, runId: 'pinned-provider-run', machineId: fixture.machineId,
                featureEnabled: true, happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                runtimeRegistryLease: fixture.lease,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            };
            await expect(admitExecutionRunInheritedProviderSelection(input)).resolves.toBeUndefined();
            // The endpoint is the sole external boundary: real admitted Agent
            // preparation, Provider policy and materialization remain in process.
            const prepared = await prepareExecutionRunProviderLaunch({ ...input,
                prepareManagedEndpoint: async () => ({ normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'pinned-consumer-token',
                    revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { endpointReleased = true; } }),
            });
            expect(prepared.providerBinding).toMatchObject({ connectionId: 'run-gateway', model: { id: 'example' } });
            expect(prepared.environment.RUN_PROVIDER_TOKEN).toBe('pinned-consumer-token');
            expect(prepared.sanitizeDiagnosticText('token pinned-consumer-token')).not.toContain('pinned-consumer-token');
            await expect(prepared.revalidateBeforeCommit()).resolves.toEqual({ ok: true });
            await prepared.cleanupOnExit?.();
            expect(endpointReleased).toBe(true);
            expect(fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.isCurrent()).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await fixture.cleanup(); }
    });

    it('keeps exact Agent and Account custody through the daemon adapter and retires prepared access after authority withdrawal', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        const resources = createProviderLaunchResourceScope();
        let current = true;
        let acquired = 0;
        let released = false;
        try {
            const backendTarget = { kind: 'backend' as const, backendId: fixture.agentId };
            const descriptor = await resolveRunnerAgentSessionDescriptorForLease({ target: backendTarget, lease: fixture.lease });
            const binding = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
            if (!descriptor || !binding) throw new Error('Expected admitted executable Agent source');
            if (!fixture.snapshot.scopeKey) throw new Error('Expected Account snapshot scope');
            const services = createRunnerExecutionRunProviderLaunchServices({ agent: { descriptor, binding }, backendTarget, runtimeRegistryLease: fixture.lease,
                retainCleanup: resources.register,
                resolvePreparation: async () => ({ machineId: fixture.machineId, featureEnabled: true,
                    happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot, isCurrent: () => current,
                    resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                    prepareManagedEndpoint: async () => {
                        acquired += 1;
                        return { normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'private-consumer-token',
                            revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { released = true; } };
                    },
                }),
            });
            const request = { backendTarget, agentId: fixture.agentId, runId: 'pinned-context-run',
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey };
            await expect(services.prepareLaunch({ ...request, expectedAccountSettingsScopeKey: 'foreign-account' })).rejects.toMatchObject({ code: 'provider_authorization_changed' });
            await expect(services.prepareLaunch({ ...request, agentId: 'foreign-agent' })).rejects.toMatchObject({ code: 'provider_authorization_changed' });
            expect(acquired).toBe(0);
            await services.admitInheritedSelection(request);
            const prepared = await services.prepareLaunch(request);
            const transported = AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
                result: { kind: 'execution_run.provider.prepared', ...projectRunnerExecutionRunProviderLaunch(prepared) } });
            expect(transported).toMatchObject({ ok: true, result: { providerBinding: { connectionId: 'run-gateway', model: { id: 'example' } },
                additionalRedactionValues: expect.arrayContaining(['private-consumer-token']) } });
            current = false;
            await expect(prepared.revalidateBeforeCommit()).resolves.toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
            expect(released).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await resources.release(); await fixture.cleanup(); }
    });

    it('revalidates the current owning Account grant rather than its initial snapshot', async () => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        let current: ActiveAccountSettingsSnapshot = fixture.snapshot;
        let released = false;
        try {
            const input = { selection: { agentTargetKey: fixture.agentTargetKey,
                providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend' as const, backendId: fixture.agentId }, agentId: fixture.agentId,
                runId: 'revoked-grant-run', machineId: fixture.machineId, featureEnabled: true,
                happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                readAccountSettingsSnapshot: () => current, runtimeRegistryLease: fixture.lease,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                prepareManagedEndpoint: async () => ({ normalizedUrl: 'http://127.0.0.1:43129', downstreamBearer: 'revoked-consumer-token',
                    revalidateBeforeCommit: async () => ({ ok: true as const }), cleanup: async () => { released = true; } }),
            };
            const prepared = await prepareExecutionRunProviderLaunch(input);
            const catalog = splitProviderSettingsV1({ ...fixture.providerSettings, machineGrants: [] }).catalog;
            current = { ...current, settingsVersion: current.settingsVersion + 1,
                providerConnectionsCatalog: { status: 'ready', revision: 2, catalog } };
            await expect(prepared.revalidateBeforeCommit()).resolves.toMatchObject({ ok: false });
            expect(released).toBe(true);
            expect(pluginReloadController.getState().activeRegistry).toBeNull();
        } finally { await fixture.cleanup(); }
    });
});
