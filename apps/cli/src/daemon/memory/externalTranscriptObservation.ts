import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { NativeUsageSourceBoundary, discoverNativeUsageSourceMetadata as DiscoverNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';

export type MemoryExternalObservation = Pick<ReturnType<typeof createExternalSessionObservationDaemonProjection>, 'registerAccountingSource'>;
type ObservationDemand = Awaited<ReturnType<MemoryExternalObservation['registerAccountingSource']>>;

/** Daemon-admitted topology only: executable readers and watch handles never cross. */
export type MemoryExternalTranscriptSourceDescriptor = Readonly<{
  agentId: string;
  sourceKey: string;
  source: AgentExternalSessionSource;
  occurrenceId: string;
  observation?: Readonly<{ id: string; changedFiles?: readonly string[] }>;
}>;

export type MemoryExternalTranscriptSourceChange = Readonly<{
  agentId: string;
  sourceKey: string;
  refreshSources: boolean;
  changedNativeSessionIds?: readonly string[];
}>;

export type MemoryExternalTranscriptSourcesSnapshot = Readonly<{
  sources: readonly MemoryExternalTranscriptSourceDescriptor[];
  configuredSourceKeys: readonly string[];
  changes: readonly MemoryExternalTranscriptSourceChange[];
}>;

/** Configured topology and executable source readiness have distinct authority. */
export async function discoverMemoryExternalTranscriptSources(input: Parameters<typeof DiscoverNativeUsageSourceMetadata>[0]) {
  const [{ discoverNativeUsageSourceMetadata }, {
    materializeConfiguredExternalSessionSourceCandidates, resolveConfiguredExternalSessionSourceAtAdmission,
  }] = await Promise.all([import('@/usage/collector/nativeUsageSourceDiscovery'), import('@/session/external/configuredSourceMaterializer')]);
  const configuredSourceKeys = new Set<string>();
  for (const candidate of materializeConfiguredExternalSessionSourceCandidates(input)) {
    if (candidate.refusal) continue;
    const boundary = await input.resolveBoundary(candidate.agentId).catch(() => null);
    const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...input,
      agentId: candidate.agentId, source: candidate.source, catalogEntry: boundary?.catalogEntry ?? null });
    if (admitted.ok) configuredSourceKeys.add(JSON.stringify([candidate.agentId, admitted.sourceKey]));
  }
  const descriptors = await discoverNativeUsageSourceMetadata({ ...input, includeAccountingSource: false });
  return { descriptors, configuredSourceKeys };
}

/** Shared daemon observation survives each finite indexer lifetime. */
export function createMemoryExternalTranscriptObservation(input: Readonly<{
  credentials: StoredCredentials;
  onChange(refreshSources: boolean, cause?: 'registry'): void;
}>) {
  let observation: MemoryExternalObservation | null = null;
  let records: readonly Readonly<{ descriptor: Omit<MemoryExternalTranscriptSourceDescriptor, 'observation'>; demand: ObservationDemand | null }>[] = [];
  let configuredSourceKeys: readonly string[] = [];
  const changes = new Map<string, MemoryExternalTranscriptSourceChange>();
  // Native incremental readers key their filesystem preparation by this
  // incumbent observation lifetime. Carry its identity, never its AbortSignal.
  const observationIds = new WeakMap<AbortSignal, string>();
  const pendingObservations = new WeakMap<ObservationDemand, ReturnType<ObservationDemand['readObservation']>>();
  let nextObservationId = 0;
  let stopped = false;
  let unsubscribeRegistry: (() => void) | null = null;
  const lifetime = new AbortController();

  const changed = (change: MemoryExternalTranscriptSourceChange) => {
    const key = JSON.stringify([change.agentId, change.sourceKey]);
    const prior = changes.get(key);
    changes.set(key, { ...change, refreshSources: change.refreshSources || prior?.refreshSources === true,
      ...(prior && (!prior.changedNativeSessionIds || !change.changedNativeSessionIds)
        ? { changedNativeSessionIds: undefined }
        : change.changedNativeSessionIds ? { changedNativeSessionIds: [...new Set([...(prior?.changedNativeSessionIds ?? []), ...change.changedNativeSessionIds])] } : {}) });
    input.onChange(change.refreshSources);
  };

  const release = async () => {
    const prior = records;
    records = [];
    configuredSourceKeys = [];
    changes.clear();
    unsubscribeRegistry?.();
    unsubscribeRegistry = null;
    await Promise.all(prior.map(record => record.demand?.dispose()));
  };

  const acquire = async (agentId: string): Promise<NativeUsageSourceBoundary | null> => {
    const [{ readRegistryCatalogHook }, { acquireAuthoritativePluginRuntimeRegistryLease }] = await Promise.all([
      import('@/agent/catalog/runtimeEntry'), import('@/plugins/runtime/reload/runtimeLease'),
    ]);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      const catalogEntry = await readRegistryCatalogHook(lease.registry, agentId, entry => entry);
      const runtime = lease.registry.agentRuntimesByAgentId.get(agentId);
      return runtime?.externalSessions && runtime.isCurrent() && !runtime.retirementSignal.aborted
        ? { catalogEntry, externalSessions: runtime.externalSessions, occurrenceId: runtime.occurrenceId,
          retirementSignal: runtime.retirementSignal, isCurrent: runtime.isCurrent } : null;
    } finally { await lease.release(); }
  };

  const refresh = async (settings: MemorySettingsV1, signal: AbortSignal) => {
    if (stopped || !observation || !settings.enabled || !settings.conversationSearch.indexExternal.enabled
      || settings.conversationSearch.indexExternal.agents.length === 0) {
      await release();
      return;
    }
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    if (!unsubscribeRegistry) {
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      unsubscribeRegistry = pluginReloadController.subscribe(() => {
        for (const { descriptor } of records) changed({ agentId: descriptor.agentId, sourceKey: descriptor.sourceKey, refreshSources: true });
        input.onChange(true, 'registry');
      });
    }
    const [{ acquireAuthoritativePluginRuntimeRegistryLease }, { configuredExternalSessionSourcesUseConnectedProfiles },
      { resolveNativeUsageSourceMetadata }] = await Promise.all([
      import('@/plugins/runtime/reload/runtimeLease'), import('@/session/external/configuredSourceMaterializer'),
      import('@/usage/collector/nativeUsageSourceDiscovery'),
    ]);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    const agents = lease.registry.contributes.agents;
    await lease.release();
    const selected = agents.filter(agent => settings.conversationSearch.indexExternal.agents.includes(agent.id));
    const account = configuredExternalSessionSourcesUseConnectedProfiles(selected)
      ? await fetchAccountProfile({ token: input.credentials.token, signal: operationSignal }) : { connectedServicesV2: [] };
    const { descriptors, configuredSourceKeys: nextConfiguredSourceKeys } = await discoverMemoryExternalTranscriptSources({ agents: selected, account,
      agentSettings: getActiveAccountSettingsSnapshot()?.settings,
      activeServerId: configuration.activeServerId, activeServerDir: configuration.activeServerDir,
      resolveBoundary: acquire, signal: operationSignal });
    operationSignal.throwIfAborted();
    const next: typeof records[number][] = [];
    try {
      for (const descriptor of descriptors) {
        const agentId = selected.find(agent => agent.identity?.pluginId === descriptor.agent.pluginId
          && agent.identity.localId === descriptor.agent.localId)?.id;
        if (!agentId) continue;
        const boundary = await acquire(agentId);
        if (!boundary) continue;
        const resolved = await resolveNativeUsageSourceMetadata({ agents: selected, agentId,
          source: descriptor.source, boundary, activeServerDir: configuration.activeServerDir, signal: operationSignal });
        if (!resolved) continue;
        const sourceKey = descriptor.configuredSourceKey ?? descriptor.sourceKey;
        const sourceObservation = resolved.metadata.accountingSource;
        const demand = sourceObservation ? await observation.registerAccountingSource({
          resource: { pluginId: descriptor.agent.pluginId, agentLocalId: descriptor.agent.localId,
            occurrenceId: boundary.occurrenceId, resourceKey: sourceObservation.resourceKey,
            retirementSignal: AbortSignal.any([lifetime.signal, boundary.retirementSignal]) },
          source: resolved.descriptor.source, changeObservation: sourceObservation.changeObservation,
          ...(sourceObservation.watchFileChanges ? { watchFileChanges: sourceObservation.watchFileChanges } : {}),
          onChange: ({ reason, changedNativeSessionIds }) => changed({ agentId, sourceKey,
            refreshSources: reason !== 'file_changed', ...(changedNativeSessionIds ? { changedNativeSessionIds } : {}) }),
        }) : null;
        next.push({ descriptor: { agentId, sourceKey, source: resolved.descriptor.source, occurrenceId: boundary.occurrenceId }, demand });
      }
      operationSignal.throwIfAborted();
    } catch (error) { await Promise.all(next.map(record => record.demand?.dispose())); throw error; }
    const prior = records;
    records = next;
    configuredSourceKeys = [...nextConfiguredSourceKeys];
    await Promise.all(prior.map(record => record.demand?.dispose()));
  };

  const getSnapshot = (): MemoryExternalTranscriptSourcesSnapshot => ({
    sources: records.map(({ descriptor, demand }) => {
      const current = demand?.readObservation();
      const pending = demand ? pendingObservations.get(demand) : undefined;
      const snapshot = current && pending?.lifetime === current.lifetime
        ? { lifetime: current.lifetime, ...(pending.changedFiles && current.changedFiles
          ? { changedFiles: [...new Set([...pending.changedFiles, ...current.changedFiles])] } : {}) }
        : current;
      if (demand && snapshot) pendingObservations.set(demand, snapshot);
      if (!snapshot || snapshot.lifetime.aborted) return descriptor;
      let id = observationIds.get(snapshot.lifetime);
      if (!id) { id = String(++nextObservationId); observationIds.set(snapshot.lifetime, id); }
      return { ...descriptor, observation: { id, ...('changedFiles' in snapshot && snapshot.changedFiles ? { changedFiles: snapshot.changedFiles } : {}) } };
    }),
    configuredSourceKeys,
    changes: [...changes.values()],
  });

  return {
    refresh, release, getSnapshot,
    hasPendingChanges: () => changes.size > 0,
    takeSnapshot() {
      const snapshot = getSnapshot();
      changes.clear();
      for (const { demand } of records) if (demand) pendingObservations.delete(demand);
      return snapshot;
    },
    attach(next: MemoryExternalObservation) {
      observation = next;
      input.onChange(true);
      return () => { if (observation === next) { observation = null; input.onChange(true); } };
    },
    async dispose() { stopped = true; lifetime.abort(); await release(); observation = null; },
  };
}
