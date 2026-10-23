import { randomUUID } from 'node:crypto';

import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import type { BackgroundServiceProcessPluginHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import { createBackgroundServiceProcessExecution } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessExecution';
import { createBackgroundServiceRunnerHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServices';
import type { MemorySettingsV1 } from '@/settings/memorySettings';

import type { MemoryIndexerConnection, MemoryIndexerHost } from './memoryIndexerBoundary';
import type { MemoryIndexerProcessServices } from './memoryIndexerServiceEntry';

type PendingOperation = Readonly<{
  invoke(connection: MemoryIndexerConnection): Promise<void>;
  reject(error: unknown): void;
}>;

/** Adapter only: the shared background-service lifecycle owns every process occurrence. */
export async function connectProcessMemoryIndexer(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  host: MemoryIndexerHost;
  readSettings(): MemorySettingsV1;
  plugins?: readonly AdmittedBackgroundServicePlugin[];
  pluginHost?: BackgroundServiceProcessPluginHost;
  spawnChannel?: Parameters<typeof createBackgroundServiceProcessExecution>[0]['spawnChannel'];
}>): Promise<MemoryIndexerConnection> {
  const serviceId = 'memory-indexer';
  const occurrenceId = randomUUID();
  const lifetime = new AbortController();
  const queued = new Set<PendingOperation>();
  let serving: { connection: MemoryIndexerConnection; pending: Set<Promise<void>>; needsDrain: boolean } | undefined;
  const { settled: onSettled, ...childHost } = params.host;
  let retired = false;
  let pendingRequestCount = 0;
  let retirement: Promise<void> | undefined;
  const lifecycle = createBackgroundServiceRunnerHost({ registrations: [],
    createContext: () => { throw new Error('memory_indexer_plugin_context_unavailable'); },
    onDiagnostic: event => { if (event.code === 'background_service_failed') params.host.failed(event.error); },
  });
  const forwardQueued = () => {
    const active = serving;
    if (!active || lifetime.signal.aborted) return;
    for (const operation of queued) {
      queued.delete(operation);
      active.needsDrain = true;
      const pending = operation.invoke(active.connection).finally(() => { active.pending.delete(pending); });
      active.pending.add(pending);
    }
  };

  const memory: MemoryIndexerProcessServices = {
    getBootstrap: async () => ({ credentials: encodeStoredCredentials(params.credentials),
      machineId: params.machineId, settings: params.readSettings() }),
    host: childHost,
    serve: async (connection, settle) => {
      const active = { connection, pending: new Set<Promise<void>>(), needsDrain: true };
      serving = active;
      try {
        forwardQueued();
        do {
          while (active.pending.size > 0) await Promise.all([...active.pending]);
          active.needsDrain = false;
          await settle();
        } while (active.pending.size > 0 || active.needsDrain);
      } finally { if (serving === active) serving = undefined; }
    },
  };
  lifecycle.register({ owner: { kind: 'host', serviceId }, occurrenceId, localId: 'indexer',
    activation: 'demand', placement: 'process',
    runner: async () => { throw new Error('memory_indexer_process_execution_required'); },
    createExecution: () => createBackgroundServiceProcessExecution({ serviceId,
      bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: null, plugins: params.plugins ?? [] },
      services: { memory, ...(params.pluginHost ? { __backgroundServiceProcessPlugins: params.pluginHost } : {}) },
      ...(params.spawnChannel ? { spawnChannel: params.spawnChannel } : {}),
    }),
  });
  lifecycle.start();

  const invoke = async <T>(run: (connection: MemoryIndexerConnection, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> => {
    if (retired) throw new Error('memory_indexer_retired');
    const signal = callerSignal ? AbortSignal.any([callerSignal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    const operation: PendingOperation = {
      invoke: async connection => {
        try { signal.throwIfAborted(); resolve(await run(connection, signal)); }
        catch (error) { reject(error); }
      }, reject,
    };
    queued.add(operation);
    let demand: ReturnType<typeof lifecycle.demand>;
    try { demand = lifecycle.demand({ serviceId, occurrenceId, localId: 'indexer' }); }
    catch (error) { queued.delete(operation); throw error; }
    forwardQueued();
    pendingRequestCount += 1;
    let succeeded = false;
    const abort = () => {
      queued.delete(operation);
      reject(signal.reason);
      demand.cancel();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const [value] = await Promise.all([result, demand.settlement]);
      succeeded = true;
      return value;
    } catch (error) {
      queued.delete(operation);
      if (!signal.aborted) params.host.failed(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      pendingRequestCount -= 1;
      if (succeeded && pendingRequestCount === 0 && queued.size === 0 && !retired && !signal.aborted) onSettled?.();
    }
  };
  return {
    applySettings: (settings, signal) => invoke((connection, signal) => connection.applySettings(settings, signal), signal),
    inventory: signal => invoke((connection, signal) => connection.inventory(signal), signal),
    tick: signal => invoke((connection, signal) => connection.tick(signal), signal),
    refresh: (sessionId, signal) => invoke((connection, signal) => connection.refresh(sessionId, signal), signal),
    revise: (change, signal) => invoke((connection, signal) => connection.revise(change, signal), signal),
    removeSessions: (ids, signal) => invoke((connection, signal) => connection.removeSessions(ids, signal), signal),
    reconcileAccess: signal => invoke((connection, signal) => connection.reconcileAccess(signal), signal),
    archive: (change, signal) => invoke((connection, signal) => connection.archive(change, signal), signal),
    readExternalPage: (request, signal) => invoke((connection, signal) => connection.readExternalPage(request, signal), signal),
    embedQuery: (text, signal) => invoke((connection, signal) => connection.embedQuery(text, signal), signal),
    indexDocuments: (update, signal) => invoke((connection, signal) => connection.indexDocuments(update, signal), signal),
    retryEmbeddings: signal => invoke((connection, signal) => connection.retryEmbeddings(signal), signal),
    retire: () => {
      retirement ??= (async () => {
        retired = true;
        lifetime.abort();
        for (const operation of queued) operation.reject(lifetime.signal.reason);
        queued.clear();
        await lifecycle.dispose();
      })();
      return retirement;
    },
  };
}
