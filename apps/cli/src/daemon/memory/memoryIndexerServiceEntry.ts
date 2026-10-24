import type { JsonValue } from '@happier-dev/protocol';

import { decodeStoredCredentials, type encodeStoredCredentials } from '@/persistence';
import type { HostBackgroundServiceProcessContext } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { MemorySettingsV1 } from '@/settings/memorySettings';

import { bindMemoryIndexerConnection } from './bindMemoryIndexerConnection';
import { createMemoryIndexer } from './memoryIndexer';
import type { MemoryIndexerConnection, MemoryIndexerHost } from './memoryIndexerBoundary';

export type MemoryIndexerProcessServices = Readonly<{
  getBootstrap(): Promise<Readonly<{
    credentials: ReturnType<typeof encodeStoredCredentials>;
    machineId: string;
    settings: MemorySettingsV1;
  }>>;
  host: Omit<MemoryIndexerHost, 'settled'>;
  serve(connection: MemoryIndexerConnection, settle: () => Promise<void>): Promise<void>;
}>;

function readMemoryServices(value: unknown): MemoryIndexerProcessServices {
  if (typeof value !== 'object' || value === null
    || !('getBootstrap' in value) || typeof value.getBootstrap !== 'function'
    || !('serve' in value) || typeof value.serve !== 'function'
    || !('host' in value) || typeof value.host !== 'object' || value.host === null
    || !['publish', 'failed', 'readExternalSources', 'observeSessions', 'runHint', 'commitHint'].every(
      name => typeof Reflect.get(value.host as object, name) === 'function')) {
    throw new Error('memory_indexer_process_services_unavailable');
  }
  // Same-binary object capabilities come only from the daemon-bound service record.
  return value as MemoryIndexerProcessServices;
}

/** Explicit host entry; no daemon registry, discovery, wake policy or credentials on argv. */
export async function runMemoryIndexerService(context: HostBackgroundServiceProcessContext, _payload: JsonValue): Promise<void> {
  const memory = readMemoryServices(context.services.memory);
  context.signal.throwIfAborted();
  const bootstrap = await memory.getBootstrap();
  const credentials = decodeStoredCredentials(bootstrap.credentials);
  if (!credentials || !bootstrap.machineId) throw new Error('memory_indexer_process_bootstrap_invalid');
  context.signal.throwIfAborted();
  const notifications = new Set<Promise<void>>();
  let notificationFailure: unknown;
  const notify = (result: void | Promise<void>): void => {
    const pending = Promise.resolve(result).catch(error => { notificationFailure ??= error; })
      .finally(() => { notifications.delete(pending); });
    notifications.add(pending);
  };
  const host: MemoryIndexerHost = {
    publish: snapshot => notify(memory.host.publish(snapshot)),
    failed: error => notify(memory.host.failed(error)),
    readExternalSources: (refresh, signal) => memory.host.readExternalSources(refresh, signal),
    observeSessions: ids => memory.host.observeSessions(ids),
    runHint: (request, signal) => memory.host.runHint(request, signal),
    commitHint: (request, signal) => memory.host.commitHint(request, signal),
  };
  const engine = await createMemoryIndexer({ credentials, machineId: bootstrap.machineId, host,
    resolveExternalReader: async agentId => {
      const runtime = context.agentRuntimesByAgentId?.get(agentId);
      return runtime?.isCurrent() && !runtime.retirementSignal.aborted ? runtime.externalSessions ?? null : null;
    } });
  const connection = bindMemoryIndexerConnection(engine);
  const abort = () => { void connection.retire().catch(() => {}); };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    await connection.applySettings(bootstrap.settings, context.signal);
    await memory.serve(connection, () => engine.runUntilSettled(context.signal));
  } finally {
    context.signal.removeEventListener('abort', abort);
    await connection.retire();
    await Promise.all([...notifications]);
  }
  if (notificationFailure && !context.signal.aborted) throw notificationFailure;
}
