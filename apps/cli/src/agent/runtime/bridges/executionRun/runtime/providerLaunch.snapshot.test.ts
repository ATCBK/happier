import { describe, expect, it, vi } from 'vitest';
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
import { logger } from '@/ui/logger';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createExecutionRunRuntime } from './create';

describe('execution-run pinned Provider preparation', () => {
    it('attributes the real lazy runtime shell once without provisioning a native Agent', async () => {
        const fixture = await createManagedRunLaunchFixture();
        const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const runtime = createExecutionRunRuntime({ cwd: fixture.happyHomeDir, happyHomeDir: fixture.happyHomeDir,
            scope: 'detached', runId: 'lazy-preparation-run', backendId: fixture.agentId, permissionMode: 'default',
            start: { intent: 'review' }, connectedServices: null,
            engineRegistry: await resolveCliEngineRegistry({ runtimeRegistry: fixture.lease.registry }) });
        try {
            await runtime.readResumeSupport();
            await runtime.readResumeSupport();
            const phases = diagnostics.mock.calls.flatMap(([marker, record]) =>
                marker === '[PROVIDER] Run preparation phase' ? [record] : []);
            expect(phases).toHaveLength(4);
            expect(phases).toEqual(['engine_resolution', 'connected_services_selection',
                'connected_services_materialization', 'runtime_create'].map(phase => ({
                runId: 'lazy-preparation-run', phase, outcome: 'completed', startedAtMs: expect.any(Number),
                finishedAtMs: expect.any(Number), elapsedMs: expect.any(Number),
            })));
        } finally { await runtime.dispose(); diagnostics.mockRestore(); await fixture.cleanup(); }
    });
    it.each(['failed', 'cancelled'] as const)('records one payload-free endpoint phase when its boundary is %s', async outcome => {
        const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
        const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const controller = new AbortController();
        const failure = new Error('private-endpoint-credential');
        try {
            await expect(prepareExecutionRunProviderLaunch({
                selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
                backendTarget: { kind: 'backend', backendId: fixture.agentId },
                agentId: fixture.agentId, runId: 'endpoint-failure-run', machineId: fixture.machineId,
                featureEnabled: true, happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot,
                runtimeRegistryLease: fixture.lease, signal: controller.signal,
                resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
                // The endpoint acquisition is the OS/network boundary; real
                // authorization and cleanup run beneath the public Run owner.
                prepareManagedEndpoint: async () => {
                    if (outcome === 'cancelled') controller.abort(failure);
                    throw failure;
                },
            })).rejects.toMatchObject({ code: 'agent_error' });
            const phases = diagnostics.mock.calls.filter(([marker]) => marker === '[PROVIDER] Run preparation phase');
            expect(phases.filter(([, record]) => typeof record === 'object' && record !== null
                && 'phase' in record && record.phase === 'managed_endpoint')).toEqual([
                ['[PROVIDER] Run preparation phase', { runId: 'endpoint-failure-run', phase: 'managed_endpoint', outcome,
                    startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number), elapsedMs: expect.any(Number) }],
            ]);
            expect(JSON.stringify(phases)).not.toContain(failure.message);
        } finally { diagnostics.mockRestore(); await fixture.cleanup(); }
    });
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
