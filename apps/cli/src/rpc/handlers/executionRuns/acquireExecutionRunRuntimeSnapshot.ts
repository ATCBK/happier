import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { ExecutionRunRpcHandlerContext } from './registerExecutionRunRpcHandlers';

/** One daemon lease supplies both the profile catalog and executable engine snapshot. */
export async function acquireExecutionRunRuntimeSnapshot(
  ctx: Pick<ExecutionRunRpcHandlerContext, 'sessionId' | 'machineId' | 'savedSecretOperationContext'>,
  controller?: PluginReloadController,
) {
  const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller });
  try {
    const engineRegistry = await resolveCliEngineRegistry({
      runtimeRegistry: runtimeRegistryLease.registry,
      ...(ctx.savedSecretOperationContext ? { savedSecretOperationContext: ctx.savedSecretOperationContext } : {}),
    });
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
        resolveAgentIdentity: (agentId) => {
          const agent = engineRegistry.contributions.agents.find((candidate) => (
            candidate.id === agentId && candidate.pluginId
          ));
          // The durable identity is the Agent's own `identity`; the
          // routing id is qualified for installed Agents and must not
          // be re-read as a local id.
          return agent?.pluginId
            ? {
              pluginId: agent.identity?.pluginId ?? agent.pluginId,
              localId: agent.identity?.localId ?? agent.definition.id,
            }
            : null;
        },
        resolvePolicyFacts: ({ agentId }) => resolveInvocationContributionPolicyFacts({
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          facts: {
            'session.agentId': agentId,
            ...(ctx.machineId ? { 'machine.id': ctx.machineId } : {}),
          },
        }),
        resolvePromptAssetBlocks: async ({ promptAsset, agentId }) => {
            return await runtimeRegistryLease.registry.resolvePromptAssetBlocks({
            agentId,
            selectedAsset: promptAsset,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
          });
        },
      });
    return {
      profileCatalog,
      engineRegistry,
      runtimeRegistry: runtimeRegistryLease.registry,
      runtimeRegistryLease,
      release: runtimeRegistryLease.release,
    };
  } catch (error) {
    await runtimeRegistryLease.release();
    throw error;
  }
}
