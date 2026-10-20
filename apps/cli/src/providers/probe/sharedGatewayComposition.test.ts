import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { logger } from '@/ui/logger';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { prepareDaemonProviderLaunch } from '@/daemon/spawn/prepareDaemonProviderLaunch';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { createSpawnPluginRuntimeLease } from '@/daemon/spawn/spawnPluginRuntimeLease';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
  createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { runHostSessionRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';

import { createRuntimeProviderServices } from './runtimeServices';

it('admits signed-out Agent Sessions through the probed local gateway and chosen hub', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'shared-gateway-spawn-' }, async ({ homeDir }) => {
    let pauseTarget = false;
    let enterTarget = () => {};
    let releaseTarget = () => {};
    const entered = new Promise<void>(resolve => { enterTarget = resolve; });
    const released = new Promise<void>(resolve => { releaseTarget = resolve; });
    let targetSignal: AbortSignal | undefined;
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
      happyHomeDir: homeDir,
      controller: pluginReloadController, physicalGateway: true, probeCatalog: true,
      signedOutAgentCli: true,
      // Only the Home target transport stalls; purpose admission remains real.
      resolveAccountTarget: async (target, signal) => {
        if (pauseTarget) { targetSignal = signal; enterTarget(); await released; }
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
      catalogModels: [{ id: 'example', connectedAccountPurposes: [{
        consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream',
      }] }],
    });
    const launchResourceScope = createProviderLaunchResourceScope();
    const redaction = createProviderRedactionLease({ values: [] });
    try {
      writeExecutableShimSync({ dir: homeDir, fileName: process.platform === 'win32' ? 'managed-run-agent.cmd' : 'managed-run-agent',
        contents: process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n' });
      const options = { directory: homeDir, machineId: fixture.machineId,
        backendTarget: { kind: 'backend' as const, backendId: fixture.agentId, sourceKind: 'built_in' as const } };
      const environmentInput = {
        options, resolvedAgentId: fixture.agentId, terminal: undefined, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        pluginRuntimeRegistry: fixture.lease.registry,
        processEnv: { NODE_ENV: 'test', PATH: homeDir, HOME: homeDir, USERPROFILE: homeDir, HAPPIER_HOME_DIR: homeDir },
        connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
        providerDiagnosticRedactionLease: redaction, launchResourceScope,
      };
      const native = await prepareDaemonSpawnChildEnvironment({ ...environmentInput, effectiveModelSelection: undefined,
        providerBindingAttempt: null, providerAgentTargetKey: null });
      expect(native, JSON.stringify(native)).toMatchObject({ ok: false,
        result: { errorCode: 'agent_signed_out', agentId: fixture.agentId } });
      const hubMachineId = fixture.machineId;
      const peerMachineId = 'peer-worker';
      const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
          gatewayPlacement: { kind: 'machine', machineId: hubMachineId } })),
      });
      const connection = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: hubMachineId,
        providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
      if (connection.status !== 'resolved') throw new Error('Expected exact hub connection');
      const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [peerMachineId, hubMachineId].map(machineId => ({
        v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
        connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint,
        endpointSetFingerprint: connection.record.endpointSetFingerprint,
      })) });
      const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: {
        status: 'ready' as const, revision: 2, catalog: splitProviderSettingsV1(settings).catalog,
      } };
      const services = createRuntimeProviderServices({ machineId: hubMachineId, happyHomeDir: fixture.happyHomeDir,
        featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
        resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: hubMachineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: hubMachineId }) }),
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
      });
      const probed = await services.probe({ connectionId: 'run-gateway', machineId: hubMachineId });
      expect(probed, JSON.stringify(probed)).toMatchObject({ status: 'success', models: [{ id: 'example',
        connectedAccountPurposes: [{ consumer: fixture.gateway!.identity, purpose: 'upstream' }],
      }] });
      if (probed.status !== 'success') throw new Error('Expected gateway catalog');
      const modelSelection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
          providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: probed.models[0]!.id } };
      const hubModels = createRuntimeProviderModelManagementServices({ machineId: hubMachineId,
        happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
        getAccountSettingsSnapshot: () => snapshot,
        acquireRuntimeLease: () => acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: homeDir }),
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutations in launch admission'); },
      });
      for (const sessionMachineId of [hubMachineId, peerMachineId]) {
        const admitted = await prepareDaemonProviderLaunch({
          options: { ...options, machineId: sessionMachineId }, effectiveBackendTarget: options.backendTarget, catalogAgentId: fixture.agentId, modelSelection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null, normalizedExistingSessionId: '',
          pluginRuntimeLease: createSpawnPluginRuntimeLease(launchResourceScope), launchResourceScope,
          resolveProvidersFeatureEnabled: () => true, processEnv: environmentInput.processEnv,
          accountSettingsSnapshot: snapshot, providerRuntimeHomeDir: fixture.happyHomeDir,
          // The hub's RPC transport is the boundary; its real Account/catalog,
          // compatibility and strict response producer remain in the composition.
          readModelProjection: async request => {
            expect(request.machineId).toBe(hubMachineId);
            return await hubModels.projectModels(request);
          },
          resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
        if (!admitted.ok) throw new Error('Expected Provider admission');
        const child = await prepareDaemonSpawnChildEnvironment({ ...environmentInput, options: admitted.options,
          effectiveModelSelection: modelSelection, providerBindingAttempt: admitted.attempt,
          providerAgentTargetKey: admitted.agentTargetKey });
        expect(child, JSON.stringify(child)).toMatchObject({ ok: true });
        if (child.ok && sessionMachineId === hubMachineId) {
          const agent = fixture.contributes.agentDefinitionsById.get(fixture.agentId);
          const registration = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId);
          const attempt = admitted.attempt;
          if (!agent || !registration?.hasPrimaryRuntime || !attempt || !('materializeManagedEndpoint' in attempt)) {
            throw new Error('Expected the real managed Agent startup owners');
          }
          const sessionId = 'gateway-child-session';
          const peerSessionId = 'gateway-peer-session';
          const metadata = attempt.authorization.sessionBindingMetadata;
          const basis = metadata.runtimeBindingBasis;
          if (!basis || basis.deployment.kind !== 'managedLocal') throw new Error('Expected admitted managed basis');
          const deployment = basis.deployment;
          const signal = new AbortController().signal;
          const openSource = createAccountConnectionManagedConsumerSourceOpen({
            homeId: 'home', accountId: 'account', machineId: hubMachineId,
            expectedAccountSettingsScopeKey: snapshot.scopeKey!, getAccountSettingsSnapshot: () => snapshot,
            custody: createManagedProviderExplicitStartCustody({ machineId: hubMachineId,
              happyHomeDir: homeDir, controller: pluginReloadController }),
            withRegistry: async read => read(fixture.contributes),
            resolveBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
            // Authenticated Session currentness is the Home transport boundary.
            admitConsumer: async request => request.consumer.kind === 'session'
              && ((request.consumer.sessionId === sessionId && request.consumerMachineId === hubMachineId)
                || (request.consumer.sessionId === peerSessionId && request.consumerMachineId === peerMachineId)),
            projectModels: request => hubModels.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => snapshot,
              resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
              signal, isCurrent: () => true }),
          });
          const consumerScope = createProviderLaunchResourceScope();
          try {
            const plan = await createNativeAgentRuntimeSessionPlanFixture({
              identity: registration, createRuntime: input => registration.createRuntime(input),
              backend: projectEngineRuntimeContributionFromAgent(agent, fixture.agentId), agent,
              authorizeNewTurn: async () => ({ status: 'admitted' }),
              createSessionHostServiceOwners,
              sessionInput: buildPluginSessionBindingInput({ credentials: { token: 'fixture-account', encryption: null },
                directory: homeDir, startedBy: 'daemon', backendTarget: options.backendTarget, modelSelection,
                environmentVariables: child.extraEnvForChild }),
              prepareManagedProviderBinding: async () => {
                const application = { agentTargetKey: basis.agentTargetKey, implementationIdentity: deployment.implementationIdentity,
                  endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol };
                const source = { kind: 'account_connection' as const, connectionId: basis.connectionId,
                  expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
                  expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
                    implementationIdentity: deployment.implementationIdentity, managedRuntime: deployment.managedRuntime,
                    purposeBindings: deployment.purposeBindings }) };
                const openConsumer = async (id: string, consumerMachineId: string) => {
                  const opened = await openSource({ source, application,
                    consumer: { kind: 'session', sessionId: id }, consumerMachineId, signal });
                  if (!opened) throw new Error('Expected admitted Session gateway consumer');
                  consumerScope.register(async () => { await opened.retire(); await opened.cleanup(); });
                  const endpointUrl = opened.access.endpointUrl(application.endpointTemplateId);
                  if (!endpointUrl) throw new Error('Expected Session gateway endpoint');
                  const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl,
                    credentialTransport: basis.runtimeCredentialTransport,
                    request: async request => await opened.revalidate(request.signal)
                      ? { ok: true, response: await opened.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
                  consumerScope.register(consumer.cleanup);
                  return { ...consumer, retire: () => opened.retire() };
                };
                const consumer = await openConsumer(sessionId, hubMachineId);
                const processFile = join(fixture.gateway!.directory, 'gateway-started');
                const localPid = await readFile(processFile, 'utf8');
                expect(Number(localPid)).toBeGreaterThan(0);
                const peer = await openConsumer(peerSessionId, peerMachineId);
                expect(await readFile(processFile, 'utf8')).toBe(localPid);
                expect(peer.credential).not.toBe(consumer.credential);
                const readModels = async (endpoint: typeof consumer, credential = endpoint.credential) => {
                  const response = await fetch(`${endpoint.endpointUrl}/models`, {
                    headers: { authorization: `Bearer ${credential}` },
                  });
                  return { status: response.status, body: await response.text() };
                };
                const localModels = await readModels(consumer);
                expect(localModels.status).toBe(200);
                expect(JSON.parse(localModels.body)).toMatchObject({ data: [{ id: 'example' }] });
                expect(await readModels(peer)).toEqual(localModels);
                expect((await readModels(peer, consumer.credential)).status).toBe(403);
                expect((await readModels(consumer, peer.credential)).status).toBe(403);
                // Retiring the peer cannot revoke the local Session or stop its
                // physical gateway while that Session still holds its claim.
                await peer.cleanup();
                await peer.retire();
                expect(await readModels(consumer)).toEqual(localModels);
                expect(await readFile(processFile, 'utf8')).toBe(localPid);
                const materialized = await attempt.materializeManagedEndpoint({ normalizedUrl: consumer.endpointUrl,
                  downstreamBearer: consumer.credential });
                if (!materialized.ok) throw new Error(materialized.error.code);
                return { handoff: { v: 1, materialization: materialized.materialization.launchMaterialization,
                    sessionBindingMetadata: metadata }, environmentOverlay: materialized.materialization.providerEnvironmentOverlay,
                  additionalRedactionValues: materialized.redactionLease.values(),
                  transformAgentChildLaunchEnvironment: environment => environment, cleanup: null };
              },
            });
            // Execute the child ingress with only its OS identity observation replaced.
            // This must get beyond the pre-webhook handoff check without a foreground resolver.
            const osBoundary = new Error('fixture-process-identity-boundary');
            await expect(runHostSessionRuntime(plan.opts, plan.config, {
              readProcessIdentityByPidFn: async () => { throw osBoundary; },
            })).rejects.toBe(osBoundary);
            const session = createNativeSessionClientTestPort(sessionId);
            const created = await plan.config.createSessionRuntime({ directory: homeDir,
              metadata: {}, machineId: hubMachineId, session,
              transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
              getPermissionMode: () => 'default', setThinking: () => undefined,
              memoryRecallGuidanceEnabled: false,
            } as never);
            expect(created.admittedProviderBindingHandoff?.sessionBindingMetadata).toEqual(metadata);
            expect(created.admittedProviderBindingHandoff?.materialization.kind).toBe('spawnEnv');
            await created.operations.resetOrDisposeRuntime();
          } finally { await consumerScope.release(); }
        }
      }
      const logs = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
      try {
        pauseTarget = true;
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        let settled = false;
        const pending = prepareDaemonProviderLaunch({ options: { ...options, machineId: peerMachineId },
          effectiveBackendTarget: options.backendTarget, catalogAgentId: fixture.agentId, modelSelection,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null, normalizedExistingSessionId: '',
          pluginRuntimeLease: createSpawnPluginRuntimeLease(launchResourceScope), launchResourceScope,
          resolveProvidersFeatureEnabled: () => true, processEnv: environmentInput.processEnv, accountSettingsSnapshot: snapshot,
          providerRuntimeHomeDir: homeDir, resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
          readModelProjection: request => hubModels.projectModels(request),
        }).then(result => { settled = true; return result; });
        await entered;
        await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs);
        const settledAtDeadline = settled;
        const withdrawnAtDeadline = targetSignal?.aborted;
        releaseTarget();
        const result = await pending;
        expect(settledAtDeadline).toBe(true);
        expect(withdrawnAtDeadline).toBe(true);
        expect(result).toMatchObject({ ok: false, result: { errorDetail: { providerError: { code: 'provider_endpoint_unavailable' } } } });
        expect(logs.mock.calls).toContainEqual(['[PROVIDER] Spawn authorization phase', expect.objectContaining({
          phase: 'purpose_bindings', status: 'failed', reason: 'deadline', connectionId: 'run-gateway', machineId: peerMachineId,
        })]);
      } finally { releaseTarget(); vi.useRealTimers(); logs.mockRestore(); }
    } finally { redaction.close(); await launchResourceScope.release(); await fixture.cleanup(); }
  });
});
