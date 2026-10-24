import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemoryExternalTranscriptSourceV1, MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { MemoryIndexSourceStatusV1, MemoryWorkerStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { DEFAULT_MEMORY_SETTINGS, readMemorySettingsFromDisk, type MemorySettingsV1 } from '@/settings/memorySettings';
import { subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { subscribeOptionalRuntimeInstallSuccess } from '@/packagedRuntime/installables/optionalRuntimes';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';
import { readRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { collectRetainedSessionInventoryVisibility, fetchSessionInventoryPage } from '@/daemon/sessions/sessionInventoryVisibility';
import { commitMemorySystemRecords } from '@/session/systemRecords/memory/commitMemorySystemRecords';
import { readCliProjectPromptStackContext } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import { logger } from '@/ui/logger';

import { resolveMemoryIndexPaths } from './memoryIndexPaths';
import { openSummaryShardIndexReader, type SummaryShardIndexReader } from './summaryShardIndexDb';
import { openDeepIndexReader, type DeepIndexReader } from './deepIndex/deepIndexDb';
import { createMemoryExternalTranscriptObservation, type MemoryExternalObservation } from './externalTranscriptObservation';
import { isExternalMemoryStorageId } from './externalTranscriptIndex';
import { buildUnavailableMemoryEmbeddingsDiagnostics, type OperationalMemoryEmbeddingsDiagnostics } from './resolveOperationalMemoryEmbeddingsSettings';
import { syncMemoryDocuments, type MemoryDocumentSearchScope } from './syncMemoryDocuments';
import { runMemoryHintsExecutionRun } from './hints/runMemoryHintsExecutionRun';
import type { ConnectMemoryIndexer, MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerSnapshot } from './memoryIndexerBoundary';
import { INITIAL_MEMORY_INVENTORY_STATE, isMemorySessionOnMachine, refreshMemoryInventoryOnce } from './inventory/refreshMemoryInventory';

export type MemoryWorkerHandle = Readonly<{
  stop: () => void | Promise<void>;
  reloadSettings: (signal?: AbortSignal) => Promise<void>;
  /** Clears derived indexes and progress without changing saved settings or the model-cache policy. */
  clearIndex: (signal?: AbortSignal) => Promise<void>;
  ensureUpToDate: (sessionId?: string, signal?: AbortSignal) => Promise<void>;
  /** Transcript revisions arrive through the incumbent durable Account change stream. */
  noteSessionTranscriptRevised?: (change: Readonly<{ sessionId: string; seq: number; messageId?: string }>) => Promise<void>;
  attachExternalObservation?: (observation: MemoryExternalObservation) => () => void;
  readExternalTranscriptPage?: (request: Readonly<{ source: MemoryExternalTranscriptSourceV1; cursor?: string }>, signal?: AbortSignal) => Promise<AgentExternalSessionsTranscriptPage | null>;
  /** Fresh attachment admission; omitted by legacy/unsupported worker implementations. */
  resolveDocumentSearchScope?: (scope: MemorySearchQueryV1['scope'], signal?: AbortSignal) => Promise<MemoryDocumentSearchScope>;
  /**
   * The memory-owner removal operation for Sessions that were deleted, whose
   * access was revoked, or that are no longer eligible. It clears the derived
   * indexes and every worker-local candidate/observed/backfill/crypto fact.
   * It rejects when the purge fails so a caller consuming a durable change
   * fact never acknowledges its cursor before the removal succeeded.
   */
  removeSessions: (sessionIds: readonly string[]) => Promise<void>;
  /** Re-checks the finite retained set after the Account changes cursor is lost. */
  reconcileRetainedSessionAccess: () => Promise<void>;
  /**
   * Every Session identity the derived index still retains. Consumers of a
   * durable access reset reconcile exactly this finite set against current
   * Account access, including while memory is disabled and the long-lived DB
   * handles are closed.
   */
  listIndexedSessionIds: () => readonly string[];
  /** Live archive-state transition from the incumbent Session update seam. */
  applySessionArchivedState: (
    change: Readonly<{ sessionId: string; archived: boolean }>,
  ) => Promise<void>;
  getSettings: () => MemorySettingsV1;
  getEmbeddingsDiagnostics: () => OperationalMemoryEmbeddingsDiagnostics;
  embedQuery?: (text: string, signal?: AbortSignal) => Promise<Float32Array | null>;
  getWorkerStatus: () => MemoryWorkerStatusV1;
  getTier1DbPath: () => string | null;
  getIndexSources?: () => readonly MemoryIndexSourceStatusV1[];
  getDeepDbPath: () => string | null;
  getTier1DbPhysicalPath?: () => string;
  getDeepDbPhysicalPath?: () => string;
}>;


/** Daemon policy, wake sources and read projection. Index writes belong to the connection. */
export async function startMemoryWorker(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  deps?: Readonly<{
    fetchDecryptedTranscriptPageAfterSeq?: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>) => Promise<DecryptedTranscriptRow[]>;
    connectIndexer?: ConnectMemoryIndexer;
  }>;
}>): Promise<MemoryWorkerHandle> {
  const paths = resolveMemoryIndexPaths();
  let stopped = false;
  let desired = DEFAULT_MEMORY_SETTINGS;
  let snapshot: MemoryIndexerSnapshot = {
    settings: desired, embeddings: buildUnavailableMemoryEmbeddingsDiagnostics(desired.embeddings),
    worker: { state: 'disabled', lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null },
    indexesQualified: false, candidateSessionIds: [], observedSeqBySessionId: [], editedSessionIds: [], externalSources: [],
  };
  let connection: MemoryIndexerConnection | null = null;
  let connecting: Promise<MemoryIndexerConnection> | null = null;
  let connectionLifetime = new AbortController();
  let retirement: Promise<void> = Promise.resolve();
  let inventoryLoop: SingleFlightIntervalLoopHandle | null = null;
  let workLoop: SingleFlightIntervalLoopHandle | null = null;
  let loopPolicy: string | null = null;
  let policyWorkRequested = false;
  let settingsApplied = false;
  let settingsOperation: Promise<void> = Promise.resolve();
  let clearPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let externalNeedsRefresh = true;
  let retireForPluginChange = false;
  const observedSessionIds = new Set<string>();
  const pendingRevisions = new Map<string, Readonly<{ sessionId: string; seq: number; messageId?: string }>>();
  const observation = createMemoryExternalTranscriptObservation({ credentials: params.credentials,
    onChange: (refresh, cause) => {
      externalNeedsRefresh ||= refresh;
      if (cause === 'registry') {
        retireForPluginChange = true;
        void reloadSettings().catch(markFailure);
      }
      workLoop?.trigger();
    } });
  const markFailure = (_error: unknown) => {
    observedSessionIds.clear();
    snapshot = { ...snapshot, worker: { ...snapshot.worker, state: 'error', currentSessionId: null, currentPhase: null } };
  };
  const host: MemoryIndexerHost = {
    publish: next => {
      const priorDeadline = snapshot.nextWorkAtMs;
      snapshot = { ...next,
        ...(next.nextWorkAtMs === undefined ? { nextWorkAtMs: priorDeadline } : {}) };
      if (snapshot.nextWorkAtMs !== priorDeadline) workLoop?.trigger();
    },
    failed: markFailure,
    settled: () => {
      if (snapshot.worker.state === 'error') return;
      snapshot = { ...snapshot, worker: { ...snapshot.worker, state: desired.enabled ? 'idle' : 'disabled',
        currentSessionId: null, currentPhase: null, activeOperations: [] },
        embeddings: snapshot.embeddings.runtimeState === 'ready' || snapshot.embeddings.runtimeState === 'downloading'
          ? { ...snapshot.embeddings, runtimeState: 'idle' } : snapshot.embeddings };
    },
    observeSessions: async ids => {
      const unseen = ids.filter(id => !observedSessionIds.has(id));
      for (const id of unseen) observedSessionIds.add(id);
      return unseen;
    },
    readExternalSources: async (refresh, signal) => {
      if (refresh || externalNeedsRefresh) {
        externalNeedsRefresh = false;
        try { await observation.refresh(desired, signal); }
        catch (error) { externalNeedsRefresh = true; throw error; }
      }
      return observation.takeSnapshot();
    },
    runHint: (request, signal) => runMemoryHintsExecutionRun({ ...request,
      cwd: configuration.activeServerDir, credentials: params.credentials, signal }),
    commitHint: async (request, signal) => {
      signal?.throwIfAborted();
      const raw = await fetchSessionById({ token: params.credentials.token, sessionId: request.sessionId, signal });
      signal?.throwIfAborted();
      if (!raw) return;
      const mode = resolveSessionStoredContentEncryptionMode(raw);
      const ctx = mode === 'plain' ? null : resolveSessionEncryptionContextFromCredentials(params.credentials, raw);
      if (mode !== 'plain' && !ctx) throw new AccountEncryptionMaterialUnavailableError();
      await commitMemorySystemRecords({ credentials: params.credentials, sessionId: request.sessionId, mode,
        ...(ctx ? { ctx } : {}), shard: { sessionId: request.sessionId, payload: request.shardPayload },
        synopsis: request.synopsisPayload ? { sessionId: request.sessionId, payload: request.synopsisPayload } : null, signal });
    },
  };
  const getIndexer = async (): Promise<MemoryIndexerConnection> => {
    await retirement;
    if (stopped) throw new Error('memory_worker_stopped');
    if (connection) return connection;
    if (connecting) return connecting;
    connectionLifetime = new AbortController();
    const pending = (async () => {
      const next = params.deps?.connectIndexer
        ? await params.deps.connectIndexer(host)
        : await connectProcessIndexer();
      connection = next;
      // The production service applies current policy in its private bootstrap;
      // only the source-test connection needs initialization at this boundary.
      try {
        if (params.deps?.connectIndexer) await next.applySettings(desired, connectionLifetime.signal);
      }
      catch (error) { connection = null; await next.retire(); throw error; }
      return next;
    })();
    connecting = pending;
    try { return await pending; }
    catch (error) { if (!connectionLifetime.signal.aborted) markFailure(error); throw error; }
    finally { if (connecting === pending) connecting = null; }
  };
  const connectProcessIndexer = async (): Promise<MemoryIndexerConnection> => {
    const { connectProcessMemoryIndexer } = await import('./processMemoryIndexer');
    const selected = desired.conversationSearch.indexExternal;
    const lease = selected.enabled && selected.agents.length
      ? await (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease()
      : null;
    try {
      const registry = lease?.registry;
      const pluginIds = registry ? [...new Set(registry.contributes.agents
        .filter(agent => selected.agents.includes(agent.id)).flatMap(agent => agent.identity ? [agent.identity.pluginId] : []))] : [];
      if (pluginIds.length && (!registry?.readAdmittedBackgroundServicePlugins || !registry.prepareBackgroundServiceProcessAgentServices)) {
        throw new Error('memory_indexer_admitted_readers_unavailable');
      }
      const indexer = await connectProcessMemoryIndexer({ credentials: params.credentials, machineId: params.machineId,
        host, readSettings: () => desired,
        plugins: registry?.readAdmittedBackgroundServicePlugins?.(pluginIds),
        ...(registry?.prepareBackgroundServiceProcessAgentServices ? { pluginHost: {
          prepareAgentInvocationServices: request => registry.prepareBackgroundServiceProcessAgentServices!(request),
        } } : {}),
      });
      return { ...indexer, retire: async () => { try { await indexer.retire(); } finally { await lease?.release(); } } };
    } catch (error) { await lease?.release(); throw error; }
  };
  const call = async <T>(run: (indexer: MemoryIndexerConnection, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const indexer = await getIndexer();
    const operationSignal = signal ? AbortSignal.any([signal, connectionLifetime.signal]) : connectionLifetime.signal;
    operationSignal.throwIfAborted();
    try { return await run(indexer, operationSignal); }
    catch (error) { if (!operationSignal.aborted) markFailure(error); throw error; }
  };
  const callWithRevisions = (run: (indexer: MemoryIndexerConnection, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) => (
    call(async (indexer, operationSignal) => {
      const revisions = new Map(pendingRevisions);
      await Promise.all([
        ...[...revisions.values()].map(change => indexer.revise(change, operationSignal)),
        run(indexer, operationSignal),
      ]);
      for (const change of revisions.values()) {
        if (pendingRevisions.get(change.sessionId) === change && !snapshot.editedSessionIds.includes(change.sessionId)) pendingRevisions.delete(change.sessionId);
      }
      return revisions;
    }, signal)
  );
  const stopLoops = async () => {
    const priorInventory = inventoryLoop;
    const priorWork = workLoop;
    inventoryLoop = null; workLoop = null; loopPolicy = null;
    await Promise.all([priorInventory?.stop(), priorWork?.stop()]);
  };
  const retireIndexer = async () => {
    connectionLifetime.abort();
    observedSessionIds.clear();
    const prior = connection;
    const priorConnecting = connecting;
    connection = null;
    retirement = (async () => {
      await stopLoops();
      const indexer = prior ?? await priorConnecting?.catch(() => null);
      // A pending factory can publish its connection after retirement began.
      // It belongs to this drain, never to the next settings occurrence.
      if (connection === indexer) connection = null;
      await indexer?.retire();
    })();
    await retirement;
  };
  const hasArchivedChange = async (signal?: AbortSignal): Promise<boolean> => {
    if (desired.includeArchivedSessions) return false;
    try {
      const archived = await collectRetainedSessionInventoryVisibility({
        retainedSessionIds: withReaders(retainedIds), scopes: ['archived'], signal,
        fetchInventoryPage: args => fetchSessionInventoryPage({ token: params.credentials.token,
          limit: desired.worker.sessionListPageLimit, ...args }),
      });
      signal?.throwIfAborted();
      if (archived.size > 0) return true;
      snapshot = { ...snapshot, settings: { ...snapshot.settings, includeArchivedSessions: false } };
    } catch (error) {
      signal?.throwIfAborted();
      // Retained rows may still be archived. Preserve the existing truthful
      // effective-policy projection until observation/purge succeeds.
      snapshot = { ...snapshot, settings: { ...snapshot.settings, includeArchivedSessions: true } };
      logger.debug('[memoryWorker] Archived observation incomplete', { message: error instanceof Error ? error.message : String(error) });
    }
    return false;
  };
  const startLoops = async () => {
    if (!configuration.isDaemonProcess || !desired.enabled || stopped) return;
    const policy = JSON.stringify(desired.worker);
    if (loopPolicy === policy && inventoryLoop && workLoop) return;
    await stopLoops();
    loopPolicy = policy;
    inventoryLoop = startSingleFlightIntervalLoop({
      // This existing freshness cadence observes metadata only. Unchanged
      // inventory never admits transcript work or prepares a child service.
      intervalMs: desired.worker.inventoryRefreshIntervalMs,
      task: async signal => {
        const observed = new Map(snapshot.observedSeqBySessionId);
        const accountEncryptionMode = (await readRequesterAccountEncryptionCurrentness({ token: params.credentials.token, signal })).mode;
        let state = INITIAL_MEMORY_INVENTORY_STATE;
        let changed = !desired.includeArchivedSessions && snapshot.settings.includeArchivedSessions
          ? await hasArchivedChange(signal) : false;
        do {
          const refresh = await refreshMemoryInventoryOnce({
            backfillPolicy: desired.backfillPolicy, includeArchivedSessions: desired.includeArchivedSessions,
            enabledAtMs: desired.enabledAtMs ?? 0, pageLimit: desired.worker.sessionListPageLimit,
            nowMs: Date.now(), state, seenSessionIds: new Set<string>(), signal,
            fetchSessionsPage: args => fetchSessionInventoryPage({ token: params.credentials.token, ...args }),
            isSessionEligible: session => {
              // Do not retain opened metadata or recreate the child's locality memo.
              const local = isMemorySessionOnMachine({ ...params, session, accountEncryptionMode });
              if (!local && observed.has(session.id)) changed = true;
              return local;
            },
          });
          signal.throwIfAborted();
          changed ||= [...refresh.observedSeqBySessionId].some(([id, seq]) => observed.get(id) !== seq);
          state = refresh.state;
          if (refresh.mode === 'snapshot') break;
        } while (!changed && (state.active.hasNext || (desired.includeArchivedSessions && state.archived.hasNext)));
        if (changed) await callWithRevisions((indexer, signal) => indexer.inventory(signal), signal);
      },
      onError: error => { markFailure(error); logger.debug('[memoryWorker] Inventory refresh failed', { message: error instanceof Error ? error.message : String(error) }); },
    });
    workLoop = startSingleFlightIntervalLoop({
      intervalMs: desired.worker.tickIntervalMs,
      task: async signal => {
        const deadlineDue = snapshot.nextWorkAtMs != null && snapshot.nextWorkAtMs <= Date.now();
        if (policyWorkRequested || pendingRevisions.size > 0 || externalNeedsRefresh
          || observation.hasPendingChanges() || deadlineDue) {
          policyWorkRequested = false;
          try { await callWithRevisions((indexer, signal) => indexer.tick(signal), signal); }
          catch (error) {
            if (!signal.aborted) {
              markFailure(error);
              logger.debug('[memoryWorker] Tick failed', { message: error instanceof Error ? error.message : String(error) });
            }
            // Failure is visible; a later real change/explicit refresh retries.
            return { nextAutomaticRunAfterMs: null };
          }
        }
        return { nextAutomaticRunAfterMs: snapshot.nextWorkAtMs == null ? null : snapshot.nextWorkAtMs - Date.now() };
      },
      onError: error => { markFailure(error); logger.debug('[memoryWorker] Tick failed', { message: error instanceof Error ? error.message : String(error) }); },
    });
    // Policy admission already inventories in its first child tick. Starting
    // a concurrent observation here would re-admit that same initial frontier.
    workLoop.trigger();
  };
  const serializeSettings = (run: () => Promise<void>) => {
    const next = settingsOperation.then(run);
    settingsOperation = next.catch(() => {});
    return next;
  };
  const applySettings = async (next: MemorySettingsV1, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const changed = JSON.stringify(next) !== JSON.stringify(desired);
    if (settingsApplied && !changed && !retireForPluginChange) {
      if (next.enabled && await hasArchivedChange(signal)) {
        await callWithRevisions((indexer, signal) => indexer.inventory(signal), signal);
      }
      await startLoops();
      return;
    }
    settingsApplied = false;
    policyWorkRequested = next.enabled;
    if (changed || retireForPluginChange) {
      // Prior-policy rows are not qualified for the replacement occurrence,
      // including when its process fails before publishing its first facts.
      snapshot = { ...snapshot, indexesQualified: false };
      await retireIndexer();
      retireForPluginChange = false;
    }
    desired = next;
    externalNeedsRefresh ||= changed;
    if (!next.enabled) {
      await retireIndexer();
      await observation.refresh(next, signal ?? new AbortController().signal);
      if (next.deleteOnDisable) await rm(paths.memoryDir, { recursive: true, force: true });
      snapshot = { ...snapshot, settings: next, indexesQualified: false,
        embeddings: buildUnavailableMemoryEmbeddingsDiagnostics(next.embeddings),
        worker: { ...snapshot.worker, state: 'disabled', currentSessionId: null, currentPhase: null, activeOperations: [] } };
      settingsApplied = true;
      return;
    }
    await ensureProtectedLocalStateDirectory(paths.memoryDir, { authority: 'owned' });
    const existing = connection;
    const indexer = await getIndexer();
    if (existing || !params.deps?.connectIndexer) await indexer.applySettings(next, signal);
    await startLoops();
    settingsApplied = true;
  };
  const reloadSettings = (signal?: AbortSignal) => serializeSettings(async () => {
    if (stopped) return;
    signal?.throwIfAborted();
    await applySettings(await readMemorySettingsFromDisk(), signal);
  });
  const withReaders = <T>(read: (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => T): T => {
    let tier1: SummaryShardIndexReader | null = null;
    let deep: DeepIndexReader | null = null;
    try {
      if (existsSync(paths.tier1DbPath)) tier1 = openSummaryShardIndexReader({ dbPath: paths.tier1DbPath });
      if (existsSync(paths.deepDbPath)) deep = openDeepIndexReader({ dbPath: paths.deepDbPath });
      return read(tier1, deep);
    } finally { deep?.close(); tier1?.close(); }
  };
  const retainedIds = (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => {
    const ids = new Set(tier1?.listIndexedSessionIds().filter(id => !isExternalMemoryStorageId(id)) ?? []);
    const externalIds = new Set(deep?.listExternalSourceStates().map(state => state.sessionId) ?? []);
    for (const id of deep?.listIndexedSessionIds() ?? []) if (!externalIds.has(id)) ids.add(id);
    return [...ids];
  };
  const resolveDocumentSearchScope = async (scope: MemorySearchQueryV1['scope'], signal?: AbortSignal): Promise<MemoryDocumentSearchScope> => {
    signal?.throwIfAborted();
    if (stopped || !desired.enabled || !snapshot.indexesQualified) return { state: 'unavailable', eligibleDocuments: [] };
    const basis = desired;
    return await syncMemoryDocuments({ credentials: params.credentials, machineId: params.machineId, scope,
      includeArchivedSessions: basis.includeArchivedSessions, signal,
      readProjectContext: (projectRef, signal) => readCliProjectPromptStackContext({ credentials: params.credentials, projectRef, signal }),
      writeIndex: (update, signal) => call((indexer, signal) => indexer.indexDocuments(update, signal), signal),
      assertCurrent: () => { if (stopped || desired !== basis) throw new Error('memory_document_scope_changed'); } });
  };
  const unsubscribeAccount = subscribeActiveAccountSettingsSnapshot((previous, next) => {
    if (!desired.enabled || (previous?.source === next?.source && previous?.settings === next?.settings)) return;
    externalNeedsRefresh = true;
    inventoryLoop?.trigger();
    workLoop?.trigger();
    if (connection) void call((indexer, signal) => indexer.retryEmbeddings(signal)).catch(markFailure);
  });
  const unsubscribeInstall = subscribeOptionalRuntimeInstallSuccess(key => {
    if (key !== INSTALLABLE_KEYS.LOCAL_EMBEDDINGS || !desired.enabled || !connection) return;
    void call((indexer, signal) => indexer.retryEmbeddings(signal)).catch(markFailure);
  });
  await reloadSettings();
  return {
    reloadSettings,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      connectionLifetime.abort();
      unsubscribeAccount(); unsubscribeInstall();
      stopPromise = (async () => { await settingsOperation; await retireIndexer(); await observation.dispose(); })();
      return stopPromise;
    },
    clearIndex: signal => {
      signal?.throwIfAborted();
      if (stopped) return Promise.reject(new Error('memory_worker_stopped'));
      if (clearPromise) return clearPromise;
      clearPromise = serializeSettings(async () => {
        const prior = desired;
        await retireIndexer();
        try {
          signal?.throwIfAborted();
          for (const path of [paths.tier1DbPath, paths.deepDbPath]) {
            for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
          }
          snapshot = { ...snapshot, indexesQualified: false, candidateSessionIds: [], observedSeqBySessionId: [], editedSessionIds: [], externalSources: [] };
          observedSessionIds.clear();
          pendingRevisions.clear();
        } finally { externalNeedsRefresh = true; settingsApplied = false; await applySettings(prior); }
      }).finally(() => { clearPromise = null; });
      return clearPromise;
    },
    ensureUpToDate: async (sessionId, signal) => {
      signal?.throwIfAborted();
      if (stopped) return;
      await reloadSettings(signal);
      if (!desired.enabled) return;
      try {
        const admittedRevisions = await callWithRevisions((indexer, signal) => indexer.refresh(sessionId, signal), signal);
        // A real revision can arrive while a source read is in flight. Keep
        // that newer fact until its own command and scheduler turn settle.
        if ([...pendingRevisions].some(([id, change]) => admittedRevisions.get(id) !== change)) await callWithRevisions(async () => {}, signal);
        await resolveDocumentSearchScope(sessionId ? { type: 'session', sessionId } : { type: 'global' }, signal);
      } catch (error) {
        // First observation can precede a cancelled retained-snapshot read.
        // The next child must still validate that snapshot's same-seq edits.
        if (signal?.aborted) {
          if (sessionId) observedSessionIds.delete(sessionId);
          else observedSessionIds.clear();
        }
        throw error;
      }
    },
    noteSessionTranscriptRevised: async change => {
      if (stopped) return;
      if (!snapshot.candidateSessionIds.includes(change.sessionId)
        && !snapshot.observedSeqBySessionId.some(([id]) => id === change.sessionId)
        && (!snapshot.indexesQualified || !withReaders(retainedIds).includes(change.sessionId))) return;
      pendingRevisions.set(change.sessionId, change);
      // Receipt must not hold the Account change stream behind transcript IO.
      // The incumbent single-flight work pump carries this fact to the child.
      workLoop?.trigger();
    },
    attachExternalObservation: next => {
      const detach = observation.attach(next);
      return detach;
    },
    readExternalTranscriptPage: (request, signal) => call((indexer, signal) => indexer.readExternalPage(request, signal), signal),
    embedQuery: async (text, signal) => {
      const vector = await call((indexer, signal) => indexer.embedQuery(text, signal), signal);
      return vector ? Float32Array.from(vector) : null;
    },
    resolveDocumentSearchScope,
    removeSessions: async ids => {
      const selected = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
      if (!selected.length) return;
      for (const id of selected) { observedSessionIds.delete(id); pendingRevisions.delete(id); }
      const loop = workLoop; loop?.pause();
      try { await call((indexer, signal) => indexer.removeSessions(selected, signal)); }
      finally { if (!stopped && desired.enabled && workLoop === loop) loop?.resume(); }
    },
    reconcileRetainedSessionAccess: () => call((indexer, signal) => indexer.reconcileAccess(signal)),
    applySessionArchivedState: change => call((indexer, signal) => indexer.archive(change, signal)),
    listIndexedSessionIds: () => snapshot.indexesQualified ? withReaders(retainedIds) : [],
    getSettings: () => snapshot.settings,
    getEmbeddingsDiagnostics: () => snapshot.embeddings,
    getWorkerStatus: () => {
      if (!snapshot.indexesQualified) return snapshot.worker;
      const observed = new Map(snapshot.observedSeqBySessionId);
      for (const change of pendingRevisions.values()) observed.set(change.sessionId,
        Math.max(observed.get(change.sessionId) ?? 0, change.seq));
      return withReaders((tier1, deep) => ({ ...snapshot.worker,
        sessionProgress: [...new Set([...snapshot.candidateSessionIds, ...snapshot.observedSeqBySessionId.map(([id]) => id), ...retainedIds(tier1, deep)])].map(sessionId => {
          const cursors = tier1?.getSessionCursors({ sessionId, nowMs: Date.now() });
          return { sessionId, observedSeq: observed.get(sessionId) ?? null,
            checkedSeq: desired.indexMode === 'deep' ? cursors?.lastObservedSeq ?? 0 : null,
            indexedSeq: desired.indexMode === 'deep' ? cursors?.lastDeepIndexedSeq ?? 0 : cursors?.lastHintedSeq ?? 0 };
        }) }));
    },
    getIndexSources: () => {
      const project = (tier1: SummaryShardIndexReader | null, deep: DeepIndexReader | null) => {
      const sessionIds = [...new Set([...snapshot.candidateSessionIds, ...snapshot.observedSeqBySessionId.map(([id]) => id), ...retainedIds(tier1, deep)])];
      const sessions: MemoryIndexSourceStatusV1[] = sessionIds.map(sessionId => {
        const source = { type: 'happier_session' as const, sessionId };
        if (!desired.enabled || (desired.indexMode === 'hints' && !desired.hints.enabled)) return { source, state: 'disabled' };
        const status = tier1?.getMemorySessionIndexStatus(sessionId);
        const pending = pendingRevisions.has(sessionId) || snapshot.editedSessionIds.includes(sessionId) || snapshot.worker.activeOperations?.some(operation => operation.kind === 'transcript' && operation.sessionIds.includes(sessionId));
        const errorCode = status === 'failed' ? tier1?.getMemorySessionIndexErrorCode(sessionId) : null;
        return { source, state: snapshot.worker.state === 'error' || status === 'failed' ? 'error'
          : !snapshot.indexesQualified || pending ? 'indexing' : status === 'indexed' || status === 'empty' ? 'ready' : 'indexing',
          ...(errorCode ? { errorCode } : {}) };
      });
      return [...sessions, ...snapshot.externalSources.map(row => !desired.enabled || !desired.conversationSearch.indexExternal.enabled
        ? { ...row, state: 'disabled' as const } : snapshot.worker.state === 'error' ? { ...row, state: 'error' as const } : row)];
      };
      return snapshot.indexesQualified ? withReaders(project) : project(null, null);
    },
    getTier1DbPath: () => !stopped && desired.enabled && snapshot.indexesQualified && existsSync(paths.tier1DbPath) ? paths.tier1DbPath : null,
    getDeepDbPath: () => !stopped && desired.enabled && snapshot.indexesQualified && existsSync(paths.deepDbPath) ? paths.deepDbPath : null,
    getTier1DbPhysicalPath: () => paths.tier1DbPath,
    getDeepDbPhysicalPath: () => paths.deepDbPath,
  };
}
