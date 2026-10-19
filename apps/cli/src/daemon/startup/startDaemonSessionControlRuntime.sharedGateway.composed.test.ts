import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '@/daemon/types';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { attestRetainedManagedProvider } from '@/plugins/runtime/composition/retainedProviderAssembly';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { configuration } from '@/configuration';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { RunnerDaemonManagedProviderBootstrapV1Schema, decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';

import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';

const boundary = vi.hoisted(() => ({
  controlInput: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));

// Replace only the loopback HTTP listener. The production dispatcher, runner
// authority, Provider admission, registry and connected-account custody stay real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.controlInput = input;
    return { port: 43129, stop: async () => {} };
  },
}));

it('prepares a titled shared gateway through runner services and refuses changed runtime authority', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'runner-shared-gateway-', env: {
    HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
  } }, async ({ homeDir }) => {
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
      happyHomeDir: homeDir, controller: pluginReloadController, physicalGateway: true });
    let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    try {
      const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`;
      const snapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(token) };
      setActiveAccountSettingsSnapshot(snapshot);
      // Live c22 rejected scope.operationClaimId:too_big: the producer embedded
      // source custody and shared placement in JSON. A valid Session id must not
      // make that opaque claim exceed the strict runner protocol's ID boundary.
      const sessionId = `runner-shared-gateway-${'session'.repeat(24)}`;
      const selection = { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' };
      const authorized = await createRuntimeProviderSpawnAuthorizationAttempt({
        selection: { v: 1, updatedAt: 1, ref: selection }, runtimeModelDescriptor: { id: 'example', name: 'Example' },
        machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
        lease: fixture.lease, getAccountSettingsSnapshot: () => snapshot,
        materializationBaseDir: join(homeDir, 'providers'), sessionId,
        managedPurposeBindingSnapshot: fixture.gateway!.purposeBindings,
      });
      expect(authorized, JSON.stringify(authorized)).toMatchObject({ ok: true });
      if (!authorized.ok) throw new Error('Expected real Provider admission');
      const metadata = authorized.attempt.authorization.sessionBindingMetadata;
      authorized.attempt.cleanupOnFailure();
      const basis = metadata.runtimeBindingBasis;
      if (!basis || basis.deployment.kind !== 'managedLocal') throw new Error('Expected real managed runtime basis');
      const mismatched = await fixture.lease.registry.createManagedProviderRuntimeInvocationServices?.({
        identity: basis.deployment.implementationIdentity,
        purposeBindings: basis.deployment.purposeBindings,
        sharedGateway: { homeId: 'home', accountId: 'account', connectionId: basis.connectionId,
          machineId: fixture.machineId, consumerId: sessionId },
        operationClaim: { kind: 'sessionDemand', sessionId,
          runtimeBindingBasis: { ...basis, deployment: { ...basis.deployment,
            managedRuntime: { ...basis.deployment.managedRuntime, requestAuthUses: [] } } },
          bindSessionCustody: async () => { throw new Error('Unexpected unshared custody'); },
        },
        signal: new AbortController().signal, isCurrent: () => true,
      });
      try {
        // Presentation-only changes are accepted below; changed request-auth
        // authority must still refuse before a gateway consumer is acquired.
        expect(mismatched).toBeNull();
      } finally { await mismatched?.cleanup(); }
      const retainedAgent = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId)?.sessionRunnerFactoryBinding;
      if (!retainedAgent) throw new Error('Expected the admitted Agent runner binding');
      const runner = { pid: process.pid, processStartTimeMs: 1717171717000,
        processCommandHash: 'a'.repeat(64), snapshotIdentity: 'version:fixture' };
      const tracked: TrackedSession = {
        pid: runner.pid, sessionRunnerPid: runner.pid, startedBy: 'daemon', happySessionId: sessionId,
        processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
        runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
        runnerAgentInvocationContext: { cwd: homeDir, environment: {}, providerBindingActive: true },
        spawnOptions: { directory: homeDir,
          backendTarget: { kind: 'backend', backendId: fixture.agentId },
          modelSelection: { v: 1, updatedAt: 1, ref: selection }, providerBindingMetadataV1: metadata },
      };
      runtime = await startDaemonSessionControlRuntime({
        machineId: fixture.machineId, serverId: configuration.activeServerId,
        serverBaseUrl: configuration.apiServerUrl, externalActionAccountId: 'account',
        credentials: { token, encryption: null }, api: {} as never,
        daemonSessionMutationCustody: {
          stageTranscriptMessage: async () => { throw new Error('Unexpected transcript write'); },
          stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
        },
        connectedServicesMaterializationBaseDir: join(homeDir, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        pidToTrackedSession: new Map([[runner.pid, tracked]]), pidToAwaiter: new Map(),
        pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(), getApiMachineForSessions: () => null,
        spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
        beforeShutdown: () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }),
      });
      const services = boundary.controlInput?.agentRuntimeDaemonServices;
      if (!services) throw new Error('Expected production runner service dispatcher');
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: 'c'.repeat(43), sessionId },
        operation: { kind: 'plugin_services.prepare_v1', requestId: 'gateway-prepare', invocationId: 'gateway-invocation' },
      });
      const prepared = await services.dispatch(request, { sessionId, runner, retainedAgent,
        invocationContext: tracked.runnerAgentInvocationContext!, trackedSession: tracked, isCurrent: async () => true });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
      if (!prepared.ok || prepared.result.kind !== 'plugin_services.result_v1') throw new Error('Expected prepared services');
      const preparedSnapshot = decodeRunnerDaemonPluginServiceWireValueV1(prepared.result.value);
      if (!preparedSnapshot || typeof preparedSnapshot !== 'object' || Array.isArray(preparedSnapshot) || !('managedProvider' in preparedSnapshot)) throw new Error('Expected managed Provider bootstrap');
      const parsedBootstrap = RunnerDaemonManagedProviderBootstrapV1Schema.safeParse(preparedSnapshot.managedProvider);
      expect(parsedBootstrap.success, JSON.stringify(parsedBootstrap)).toBe(true);
      if (!parsedBootstrap.success) throw new Error('Expected valid managed Provider bootstrap');
      const bootstrap = parsedBootstrap.data;
      expect(bootstrap.scope.runtimeBindingBasis).toStrictEqual(basis);
      const wrongClaim = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
        v: 1, context: request.context,
        operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-wrong-claim',
          invocationId: 'gateway-invocation', retained: { v: 1,
            scope: { ...bootstrap.scope, operationClaimId: 'different-claim' }, custody: bootstrap.custody,
            providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
      }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
        trackedSession: tracked, isCurrent: async () => true });
      expect(wrongClaim).toMatchObject({ ok: false, error: {
        code: 'plugin_services_managed_provider_retention_mismatch',
        cause: { code: 'managed_provider_retention_scope_operation_claim_id', stage: 'dispatch' } } });
      const started = await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
        v: 1, context: request.context,
        operation: { kind: 'plugin_services.managed_provider.start_v1', requestId: 'gateway-start',
          invocationId: 'gateway-invocation', retained: { v: 1, scope: bootstrap.scope,
            custody: bootstrap.custody,
            providerPluginHardRevocationRevisionAtAdmission: bootstrap.providerPluginHardRevocationRevisionAtAdmission } },
      }), { sessionId, runner, retainedAgent, invocationContext: tracked.runnerAgentInvocationContext!,
        trackedSession: tracked, isCurrent: async () => true });
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      const providerRuntime = await fixture.lease.registry.acquireManagedProviderRuntime?.(basis.deployment.implementationIdentity);
      if (!providerRuntime) throw new Error('Expected admitted gateway runtime');
      const retained = await attestRetainedManagedProvider({ paths: resolvePluginStorePaths({ happyHomeDir: homeDir }),
        sessionId, identity: basis.deployment.implementationIdentity,
        occurrenceId: providerRuntime.activationOccurrenceId, sourceCustody: providerRuntime.sourceCustody,
        manifestAuthority: 'external', runtimeBindingBasis: basis });
      expect(retained).toMatchObject({ identity: basis.deployment.implementationIdentity });
    } finally {
      await runtime?.stopControlServer();
      resetActiveAccountSettingsSnapshotForTests();
      boundary.controlInput = null;
      await fixture.cleanup();
    }
  });
});
