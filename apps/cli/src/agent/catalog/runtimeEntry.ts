import { AGENTS } from './registry';
import type { AgentCatalogEntry, CatalogAgentId } from './types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

/** A native factory may omit a CLI; a declaration alone never proves that factory. */
export function requiresAgentSessionCli(agentId: CatalogAgentId, registry: ResolvedExecutablePluginRuntimeRegistry): boolean {
  const agent = registry.contributes.agentDefinitionsById.get(agentId);
  const definition = agent?.richDefinition?.definition;
  const runtime = registry.agentRuntimesByAgentId.get(agentId);
  const binding = runtime?.sessionRunnerFactoryBinding;
  return !(agent && definition && 'runtime' in definition && definition.runtime.kind === 'custom'
    && definition.primary === 'sessions'
    && definition.cli === undefined
    && agent?.cliMetadata == null
    && agent.runtimeSpec == null
    && runtime?.hasPrimaryRuntime === true
    && runtime.isCurrent()
    && binding && 'locator' in binding
    && binding.agentId === agentId
    && binding.pluginId === agent.identity?.pluginId
    && binding.localAgentId === agent.identity?.localId);
}

/** Observes the same admitted factory used by Session launch, never manifest-only readiness. */
export async function observeCurrentAgentSessionFactory(agentId: CatalogAgentId): Promise<Readonly<{
  nativeAuthenticationRequired: boolean;
  isCurrent(): boolean;
}> | null> {
  const { tryAcquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
  const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  if (!lease) return null;
  try {
    const agent = lease.registry.contributes.agentDefinitionsById.get(agentId);
    const definition = agent?.richDefinition?.definition;
    if (!agent || !definition || !('runtime' in definition) || definition.runtime.kind !== 'custom' || definition.primary !== 'sessions'
      || definition.cli !== undefined || agent?.cliMetadata != null || agent.runtimeSpec != null) return null;
    const { activateAgentRuntimeContributionOnDemand } = await import('@/agent/runtime/registry/activationDemand');
    await activateAgentRuntimeContributionOnDemand(lease.registry, agentId);
    if (requiresAgentSessionCli(agentId, lease.registry)) return null;
    const runtime = lease.registry.agentRuntimesByAgentId.get(agentId)!;
    return Object.freeze({
      nativeAuthenticationRequired: Boolean(runtime.cliAuth || runtime.connectedAccountLaunch
        || definition.connectedAccounts?.length),
      isCurrent: () => lease.registry.agentRuntimesByAgentId.get(agentId) === runtime
        && !requiresAgentSessionCli(agentId, lease.registry),
    });
  } finally {
    await lease.release();
  }
}

async function acquireRegistryCatalogEntry(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  agentId: CatalogAgentId,
): Promise<AgentCatalogEntry | null> {
  return registry.acquireAgentCatalogEntry
    ? await registry.acquireAgentCatalogEntry(agentId)
    : registry.contributes.agents.find((agent) => agent.id === agentId)?.catalogEntry ?? null;
}

/** The caller's existing lease owns this entry and its executable hooks. */
export async function readRegistryCatalogHook<T>(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  agentId: CatalogAgentId,
  read: (entry: AgentCatalogEntry) => T | Promise<T>,
): Promise<T | null> {
  const entry = await acquireRegistryCatalogEntry(registry, agentId);
  return entry ? await read(entry) : null;
}

async function acquireCurrentCatalogEntry(
  agentId: CatalogAgentId,
): Promise<Readonly<{
  entry: AgentCatalogEntry | null;
  release(): Promise<void>;
}>> {
  const { acquireAuthoritativePluginRuntimeRegistryLease } = await import(
    '@/plugins/runtime/reload/runtimeLease'
  );
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  } catch (error) {
    if (
      error instanceof Error
      && Reflect.get(error, 'code') === 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE'
    ) {
      return Object.freeze({ entry: AGENTS[agentId] ?? null, release: async () => {} });
    }
    throw error;
  }
  try {
    const entry = await acquireRegistryCatalogEntry(lease.registry, agentId);
    return Object.freeze({ entry, release: lease.release });
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
}

export async function readCurrentCatalogHook<T>(
  agentId: CatalogAgentId,
  read: (entry: AgentCatalogEntry) => T | Promise<T>,
): Promise<T | null> {
  const acquired = await acquireCurrentCatalogEntry(agentId);
  try {
    return acquired.entry ? await read(acquired.entry) : null;
  } finally {
    await acquired.release();
  }
}

