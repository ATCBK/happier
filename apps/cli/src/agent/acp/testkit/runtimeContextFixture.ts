import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { AgentContribution } from '@happier-dev/plugin-sdk/agents';
import type { AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { composeNativeAgentSessionRuntimeContext, createNativeAgentSessionHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentExecutionRunHostServices, createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications, type NativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

/** Uses the real Session authorities; callers supply only their ACP/process boundary. */
export function createAcpSessionRuntimeContextFixture(params: Readonly<{
  agent: AgentContribution;
  pluginId: string;
  pluginVersion?: string;
  occurrenceId?: string;
  sessionId: string;
  directory: string;
  signal: AbortSignal;
  session?: ApiSessionClient;
  permissionHandler?: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
  publications?: NativeAgentSessionPublications;
  readToolExecutionCapability?: Parameters<typeof createNativeAgentSessionHostServices>[0]['readToolExecutionCapability'];
  services?: PluginServices;
  protocols: AgentSessionRuntimeContext['protocols'];
}>): Readonly<{ context: AgentSessionRuntimeContext; dispose(): Promise<void> }> {
  const session = params.session ?? createMutableApiSessionClientFixture({ sessionId: params.sessionId });
  const isCurrent = () => !params.signal.aborted;
  const identity = { pluginId: params.pluginId, pluginVersion: params.pluginVersion ?? '0.0.0', agentId: params.agent.id };
  const occurrenceId = params.occurrenceId ?? `fixture:${params.sessionId}`;
  const publications = params.publications ?? createNativeAgentSessionPublications({
    agentId: params.agent.id, session, signal: params.signal, isCurrent, supportsInFlightSteer: false,
  });
  const owners = createNativeAgentSessionHostServiceOwners({
    identity: { ...identity, occurrenceId }, runtimeRegistry: null,
    agent: projectManifestAgentContribution({ definition: params.agent, pluginId: params.pluginId,
      provenance: 'external', source: { kind: 'path' } }),
    backend: { id: params.agent.id, agentId: params.agent.id, provenance: 'external', source: { kind: 'path' },
      definition: { kindVersion: 1, id: params.agent.id, agentId: params.agent.id } },
    hostSession: { session, machineId: 'fixture',
      permissionHandler: params.permissionHandler ?? new ProviderEnforcedPermissionHandler(session, { logPrefix: '[ACP fixture]' }),
      accountSettingsAuthority: 'session' },
    sessionId: params.sessionId, directory: params.directory, happyHomeDir: params.directory, signal: params.signal,
  });
  const context = composeNativeAgentSessionRuntimeContext({
    identity, contributionId: params.agent.id, invokedAtMs: Date.now(), sessionId: params.sessionId,
    signal: params.signal, services: params.services ?? createUnavailablePluginServices(), ui: undefined,
    sessionServices: createNativeAgentSessionHostServices({ owners, session, publications: publications.services,
      agentId: params.agent.id, sessionId: params.sessionId, directory: params.directory, signal: params.signal, isCurrent,
      readToolExecutionCapability: params.readToolExecutionCapability ?? (() => null) }),
    workState: createNativeAgentSessionWorkStateService({ session, pluginId: params.pluginId,
      contributionId: params.agent.id, agentId: params.agent.id, occurrenceId,
      declarations: readAgentSessionCapabilities(params.agent)?.workStateSources ?? [], isCurrent }),
    protocols: params.protocols,
  });
  return { context, async dispose() {
    publications.dispose();
    try { await owners.dispose(); }
    finally { if (!params.session) await session.close(); }
  } };
}

/** Run services have their own scope and never borrow a Session's identity or services. */
export function createAcpExecutionRunRuntimeContextFixture(params: Readonly<{
  pluginId: string;
  pluginVersion?: string;
  agentId: string;
  executionRunId: string;
  directory: string;
  signal: AbortSignal;
  services?: PluginServices;
  protocols: AgentExecutionRunRuntimeContextV1['protocols'];
}>): Readonly<{ context: AgentExecutionRunRuntimeContextV1; dispose(): Promise<void> }> {
  const services = params.services ?? createUnavailablePluginServices();
  const owner = createNativeAgentExecutionRunHostServices({
    signal: params.signal, executionRunId: params.executionRunId, directory: params.directory,
    happyHomeDir: params.directory, machineId: 'fixture', accountSettings: null, runtimeRegistry: null,
    pluginId: params.pluginId, agentId: params.agentId,
  });
  const context: AgentExecutionRunRuntimeContextV1 = {
    plugin: { id: params.pluginId, version: params.pluginVersion ?? '0.0.0' },
    contribution: { id: params.agentId, qualifiedId: resolveAgentContributionQualifiedId({ pluginId: params.pluginId, localId: params.agentId }) },
    surface: 'agent', invokedAtMs: Date.now(), signal: params.signal, services,
    agent: { id: params.agentId }, protocols: params.protocols,
    scope: { kind: 'execution_run', executionRunId: params.executionRunId },
    executionRun: { id: params.executionRunId, services: { ...owner, nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec) } },
  };
  return { context, async dispose() { await owner.dispose(); } };
}
