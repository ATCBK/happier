import type { Disposable } from '@happier-dev/plugin-sdk';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { NativeUsageSourceBoundary } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { discoverNativeUsageSourceMetadata as DiscoverNativeUsageSourceMetadata } from '@/usage/collector/nativeUsageSourceDiscovery';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import { externalMemoryStorageId, type MemoryExternalSourceReader } from './externalTranscriptIndex';
import { resolveMemoryCoverageCreatedAtCutoffMs } from './transcript/coveragePolicy';
import { logger } from '@/ui/logger';

export type MemoryExternalObservation = Pick<ReturnType<typeof createExternalSessionObservationDaemonProjection>, 'registerAccountingSource'>;

type MemoryExternalTranscriptCandidate = Readonly<{
  source: MemoryExternalTranscriptSourceV1;
  native: MemoryExternalSourceReader;
}>;

type NativeInventory = {
  native: MemoryExternalSourceReader;
  candidates: Map<string, MemoryExternalTranscriptCandidate>;
  pending: Map<string, MemoryExternalTranscriptCandidate> | null;
  cursor?: string;
  seen: Set<string>;
  needsInventory: boolean;
  failed: boolean;
};

/** The incumbent source inventory owns its one in-memory traversal position. */
export function createMemoryExternalTranscriptTraversal() {
  let candidates: readonly MemoryExternalTranscriptCandidate[] = [];
  let candidateIndex = 0;
  const results = new Map<string, 'current' | 'more' | 'removed' | 'error'>();
  return {
    replace(next: readonly MemoryExternalTranscriptCandidate[]) {
      const upcoming = candidates.length ? candidates[candidateIndex % candidates.length] : undefined;
      const upcomingId = upcoming ? externalMemoryStorageId(upcoming.source) : null;
      const retainedIndex = upcomingId === null ? -1
        : next.findIndex(candidate => externalMemoryStorageId(candidate.source) === upcomingId);
      const retainedIds = new Set(next.map(candidate => externalMemoryStorageId(candidate.source)));
      for (const id of results.keys()) if (!retainedIds.has(id)) results.delete(id);
      candidates = next;
      candidateIndex = next.length ? retainedIndex >= 0 ? retainedIndex : candidateIndex % next.length : 0;
    },
    size() { return candidates.length; },
    invalidate(agentId?: string, sourceKey?: string) {
      for (const candidate of candidates) {
        if ((agentId === undefined || candidate.source.agentId === agentId)
          && (sourceKey === undefined || candidate.source.sourceKey === sourceKey)) results.delete(externalMemoryStorageId(candidate.source));
      }
    },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error') {
      results.set(externalMemoryStorageId(source), state);
    },
    getIndexSources(db: Pick<DeepIndexDbHandle, 'getExternalSourceState'> | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map<string, MemoryIndexSourceStatusV1>();
      for (const candidate of candidates) {
        const { agentId, sourceKey } = candidate.source;
        const id = externalMemoryStorageId(candidate.source);
        const result = results.get(id);
        const state = result === 'error' ? 'error' : result === 'current' && db?.getExternalSourceState({ sessionId: id })?.coverageComplete === true ? 'ready' : 'indexing';
        const key = JSON.stringify([agentId, sourceKey]);
        const previous = groups.get(key);
        if (!previous || state === 'error' || (previous.state !== 'error' && state !== 'ready')) {
          groups.set(key, { source: { type: 'external_transcript', agentId, sourceKey }, state });
        }
      }
      return [...groups.values()];
    },
    take(count: number) {
      const result: MemoryExternalTranscriptCandidate[] = [];
      for (let i = 0; i < Math.min(count, candidates.length); i++) {
        result.push(candidates[candidateIndex]!);
        candidateIndex = (candidateIndex + 1) % candidates.length;
      }
      return result;
    },
  };
}

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
  const descriptors = await discoverNativeUsageSourceMetadata(input);
  return { descriptors, configuredSourceKeys };
}

/** Configured native sources consume the incumbent observation resource owner. */
export function createMemoryExternalTranscriptSources(input: Readonly<{
  credentials: StoredCredentials;
  onChange(refreshSources: boolean): void;
}>) {
  let observation: MemoryExternalObservation | null = null;
  let records: ReadonlyArray<MemoryExternalSourceReader & { demand: Disposable | null }> = [];
  const traversal = createMemoryExternalTranscriptTraversal();
  const inventories = new Map<string, NativeInventory>();
  let inventoryChanged = false;
  let configuredSourceKeys = new Set<string>();
  const completeSources = new Set<string>();
  let stopped = false;
  let indexSettings: MemorySettingsV1 | null = null;
  let unsubscribeRegistry: (() => void) | null = null;
  const lifetime = new AbortController();

  const releaseSources = async () => {
    const prior = records;
    records = [];
    traversal.replace([]);
    configuredSourceKeys.clear();
    completeSources.clear();
    inventories.clear();
    inventoryChanged = false;
    indexSettings = null;
    unsubscribeRegistry?.();
    unsubscribeRegistry = null;
    await Promise.all(prior.map(record => record.demand?.dispose()));
  };

  const invalidateInventory = (agentId?: string, sourceKey?: string, changed = true) => {
    for (const [key, state] of inventories) {
      if ((agentId === undefined || state.native.agentId === agentId)
        && (sourceKey === undefined || state.native.sourceKey === sourceKey)
        && (changed || state.pending === null)) {
        state.needsInventory = true;
        completeSources.delete(key);
      }
    }
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
      await releaseSources();
      return;
    }
    if (indexSettings && indexSettings.conversationSearch.indexExternal.historyDays
      !== settings.conversationSearch.indexExternal.historyDays) invalidateInventory();
    indexSettings = settings;
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    if (!unsubscribeRegistry) {
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      unsubscribeRegistry = pluginReloadController.subscribe(() => { invalidateInventory(); traversal.invalidate(); input.onChange(true); });
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
        const sourceObservation = resolved.metadata.accountingSource;
        const demand = sourceObservation ? await observation.registerAccountingSource({
          resource: { pluginId: descriptor.agent.pluginId, agentLocalId: descriptor.agent.localId,
            occurrenceId: boundary.occurrenceId, resourceKey: sourceObservation.resourceKey,
            retirementSignal: AbortSignal.any([lifetime.signal, boundary.retirementSignal]) },
          source: resolved.descriptor.source, changeObservation: sourceObservation.changeObservation,
          ...(sourceObservation.watchFileChanges ? { watchFileChanges: sourceObservation.watchFileChanges } : {}),
          onChange: ({ reason }) => {
            // Known-file changes go through the retained transcript frontier.
            // Only structural/source changes need a fresh source-wide file set.
            const refreshSources = reason !== 'file_changed';
            if (refreshSources) invalidateInventory(agentId, descriptor.configuredSourceKey ?? descriptor.sourceKey);
            traversal.invalidate(agentId, descriptor.configuredSourceKey ?? descriptor.sourceKey);
            input.onChange(refreshSources);
          },
        }) : null;
        next.push({ agentId, sourceKey: descriptor.configuredSourceKey ?? descriptor.sourceKey, source: resolved.descriptor.source,
          reader: boundary.externalSessions, demand });
      }
      operationSignal.throwIfAborted();
    } catch (error) { await Promise.all(next.map(record => record.demand?.dispose())); throw error; }
    const prior = records;
    records = next;
    configuredSourceKeys = nextConfiguredSourceKeys;
    const retainedKeys = new Set<string>();
    for (const native of records) {
      const key = JSON.stringify([native.agentId, native.sourceKey]);
      retainedKeys.add(key);
      const previous = inventories.get(key);
      // Refreshing observation demand must not restart an in-progress crawl.
      // A replaced reader or physical source does require fresh absence proof.
      if (previous?.native.reader === native.reader
        && JSON.stringify(previous.native.source) === JSON.stringify(native.source)) continue;
      inventories.set(key, { native, candidates: new Map(), pending: null, seen: new Set(), needsInventory: true, failed: false });
      inventoryChanged = true;
      completeSources.delete(key);
    }
    for (const key of inventories.keys()) if (!retainedKeys.has(key)) {
      inventories.delete(key);
      completeSources.delete(key);
      inventoryChanged = true;
    }
    await Promise.all(prior.map(record => record.demand?.dispose()));
  };

  const inventory = async (signal: AbortSignal) => {
    if (!observation || !indexSettings) return null;
    const cutoff = resolveMemoryCoverageCreatedAtCutoffMs({ nowMs: Date.now(), enabledAtMs: 0,
      historyDays: indexSettings.conversationSearch.indexExternal.historyDays });
    let changed = inventoryChanged;
    inventoryChanged = false;
    for (const native of records) {
      const key = JSON.stringify([native.agentId, native.sourceKey]);
      const state = inventories.get(key)!;
      if (state.needsInventory && state.pending === null) {
        state.pending = new Map();
        state.cursor = undefined;
        state.seen.clear();
        state.needsInventory = false;
        completeSources.delete(key);
      }
      if (state.pending === null) continue;
      changed = true;
      try {
        // Consume one existing bounded native page per source, then let the
        // worker ingest it. A large sibling cannot hold all transcript work
        // behind its whole-corpus inventory. Continuations live here, in the
        // incumbent inventory owner, across ticks and observation refreshes.
        const page = await native.reader.listCandidates({ source: native.source,
          maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems,
          maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxSerializedBytes,
          ...(state.cursor ? { cursor: state.cursor } : {}), signal });
        signal.throwIfAborted();
        if (!page.ok) throw new Error(page.code);
        state.failed = false;
        for (const candidate of page.value.candidates) {
          // Native activity metadata is the source's last-update authority.
          // Unknown activity stays eligible; an expired source never needs a
          // link-identity or transcript read just to discard its old rows.
          if (cutoff !== null && typeof candidate.updatedAtMs === 'number' && candidate.updatedAtMs < cutoff) continue;
          const identity = await native.reader.resolveLinkIdentity({ source: native.source,
            remoteSessionId: candidate.remoteSessionId, ...(candidate.linkData ? { linkData: candidate.linkData } : {}), signal });
          signal.throwIfAborted();
          if (!identity.ok) { state.needsInventory = true; continue; }
          const source = { type: 'external_transcript' as const,
            agentId: native.agentId, sourceKey: native.sourceKey, nativeSessionId: identity.value.remoteSessionId };
          state.pending.set(externalMemoryStorageId(source), { native: { ...native, source: identity.value.source }, source });
        }
        if (page.value.nextCursor) {
          if (state.seen.has(page.value.nextCursor)) throw new Error('memory_external_inventory_cursor_stalled');
          state.cursor = page.value.nextCursor;
          state.seen.add(state.cursor);
        } else {
          // Preparation describes the native inventory chunk, including its
          // terminal page. Its exhausted cursor establishes inventory completion.
          if (!state.needsInventory && !page.value.searchIncomplete) {
            state.candidates = state.pending;
            completeSources.add(key);
          } else {
            // Changes during a crawl or an incomplete page cannot prove absence.
            state.candidates = new Map([...state.candidates, ...state.pending]);
            state.needsInventory = true;
          }
          state.pending = null;
        }
      } catch (error) {
        signal.throwIfAborted();
        state.candidates = new Map([...state.candidates, ...(state.pending ?? [])]);
        state.pending = null;
        state.needsInventory = true;
        state.failed = true;
        completeSources.delete(key);
        logger.debug('[memoryWorker] Native inventory failed; retaining incomplete coverage', {
          agentId: native.agentId, sourceKey: native.sourceKey, message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!changed) return null;
    const candidates = new Map([...inventories.values()].flatMap(state => [...state.candidates, ...(state.pending ?? [])]));
    traversal.replace([...candidates.values()]);
    return { current: new Set(candidates.keys()), completeSources, configuredSourceKeys };
  };

  return {
    refresh,
    inventory,
    // A periodic inventory request does not invalidate an unfinished crawl.
    invalidate() { invalidateInventory(undefined, undefined, false); },
    noteSyncResult(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error') {
      traversal.noteSyncResult(source, state);
      if (state === 'removed') {
        invalidateInventory(source.agentId, source.sourceKey);
        input.onChange(true);
      }
    },
    getIndexSources(db: DeepIndexDbHandle | null): MemoryIndexSourceStatusV1[] {
      const groups = new Map(traversal.getIndexSources(db).map(row =>
        [JSON.stringify([row.source.type === 'external_transcript' ? row.source.agentId : '', row.source.type === 'external_transcript' ? row.source.sourceKey : '']), row]));
      return [...configuredSourceKeys].map(key => {
        const [agentId, sourceKey] = JSON.parse(key) as [string, string];
        const inventory = inventories.get(key);
        return { source: { type: 'external_transcript', agentId, sourceKey },
          state: !db ? 'indexing' : inventory?.failed ? 'error'
            : !completeSources.has(key) ? 'indexing' : groups.get(key)?.state ?? 'ready' };
      });
    },
    getReadySourceCount: traversal.size,
    attach(next: MemoryExternalObservation) {
      observation = next;
      invalidateInventory();
      input.onChange(true);
      return () => { if (observation === next) { observation = null; invalidateInventory(); input.onChange(true); } };
    },
    take: traversal.take,
    async readPage(request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, settings: MemorySettingsV1, signal: AbortSignal) {
      if (!records.length) await refresh(settings, signal);
      const native = records.find(record => record.agentId === request.source.agentId && record.sourceKey === request.source.sourceKey);
      if (!native) return null;
      const identity = await native.reader.resolveLinkIdentity({ source: native.source,
        remoteSessionId: request.source.nativeSessionId, signal });
      if (!identity.ok) return null;
      const result = await native.reader.pageTranscript({ source: identity.value.source, remoteSessionId: identity.value.remoteSessionId,
        direction: 'older', ...(request.cursor ? { cursor: request.cursor } : {}),
        maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
        maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes, signal });
      return result.ok ? result.value : null;
    },
    async dispose() { stopped = true; lifetime.abort(); await releaseSources(); observation = null; },
  };
}
