import { PluginError } from '@happier-dev/plugin-sdk';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority,
  type AgentRuntimeDaemonServiceAuthorityExpectedInput } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { ExecutionRunRpcHandlerContext } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { createRunnerAgentSessionRuntimeSource } from './runnerAgentSessionRuntimeSource';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from './agentRuntimeDaemonServiceAuthorityClient';
import type { AgentRuntimeDaemonServiceRequestV1 } from './agentRuntimeDaemonServiceProtocol';

export function createRunnerExecutionRunSnapshotResolver(input: Readonly<{ sessionId: string; machineId?: string }>):
  NonNullable<ExecutionRunRpcHandlerContext['resolveExecutionRunProfileCatalog']> {
  const unavailable = () => { throw new PluginError({ code: 'execution_run_contribution_snapshot_unavailable',
    message: 'Execution Run executable snapshot is unavailable' }); };
  return async backendTarget => {
    const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
    if (!path) return unavailable();
    const current = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, expectedSessionId: input.sessionId });
    if (!current) return unavailable();
    const authority: AgentRuntimeDaemonServiceAuthorityExpectedInput = {
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId: input.sessionId, runner: current.runner, retainedAgent: current.retainedAgent,
    };
    const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string) => {
      const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority, timeoutMs: null,
        createRequest: token => ({ v: 1, context: { token, sessionId: input.sessionId,
          ...(executionRunSnapshotId ? { executionRunSnapshotId } : {}) }, operation }) });
      if (!response.ok) return unavailable();
      return response.result;
    };
    const snapshot = await dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      ...(backendTarget ? { backendTarget: readBackendTargetRefV2(backendTarget) } : {}) });
    if (snapshot.kind !== 'execution_run.snapshot') return unavailable();
    let source: Awaited<ReturnType<typeof createRunnerAgentSessionRuntimeSource>> = null;
    const releaseDaemon = async () => {
      const result = await dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId: snapshot.snapshotId });
      if (result.kind !== 'execution_run.snapshot.released') return unavailable();
    };
    try {
      const after = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: input.sessionId });
      if (!after || after.capability !== current.capability || after.httpPort !== current.httpPort) return unavailable();
      if (snapshot.agent) {
        source = await createRunnerAgentSessionRuntimeSource({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          authorityFilePath: path, expectedSessionId: input.sessionId,
          occurrenceId: snapshot.agent.descriptor.occurrenceId,
          runtimeAuthority: snapshot.agent.descriptor.runtimeAuthority,
          executionRunSnapshot: snapshot,
        });
        if (!source) return unavailable();
      } else if (backendTarget) return unavailable();
      const engineRegistry = await resolveCliEngineRegistry({
        contributes: createResolvedContributionRegistry({ agents: source ? [source.agentContribution] : [] }),
        ...(source ? { backendId: source.identity.backendId, runnerAgentSessionRuntimeSource: source,
          requireRunnerAgentSessionRuntimeSource: true } : {}),
      });
      const profileCatalog = buildExecutionRunProfileCatalog(snapshot.profiles, {
        resolveAgentIdentity: agentId => engineRegistry.contributions.agentDefinitionsById.get(agentId)?.identity ?? null,
        resolvePolicyFacts: ({ agentId }) => resolveInvocationContributionPolicyFacts({ sessionId: input.sessionId,
          facts: { 'session.agentId': agentId, ...(input.machineId ? { 'machine.id': input.machineId } : {}) } }),
        resolvePromptAssetBlocks: async ({ promptAsset }) => {
          const result = await dispatch({ kind: 'turn_contributions.resolve', requestId: snapshot.snapshotId,
            request: { kind: 'prompt', selectedAsset: promptAsset,
              ...(input.machineId ? { machineId: input.machineId } : {}) } }, snapshot.snapshotId);
          if (result.kind !== 'turn_contributions' || result.contributions.kind !== 'prompt') return unavailable();
          return result.contributions.promptAssetBlocks;
        },
      });
      const ready = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: input.sessionId });
      if (!ready || ready.capability !== current.capability || ready.httpPort !== current.httpPort) return unavailable();
      let released = false;
      return { profileCatalog, engineRegistry, release: async () => {
        if (released) return;
        try { await source?.retire?.(); } finally { await releaseDaemon(); }
        released = true;
      } };
    } catch (error) {
      try { await source?.retire?.(); } finally { await releaseDaemon(); }
      throw error;
    }
  };
}
