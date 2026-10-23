import type { StoredCredentials } from '@/persistence';
import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { createMemoryIndexer } from '../memoryIndexer';
import { bindMemoryIndexerConnection } from '../bindMemoryIndexerConnection';
import type { MemoryIndexerConnection, MemoryIndexerHost } from '../memoryIndexerBoundary';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

/** Source-test binding for injected transcript transport; production uses process placement. */
export async function connectInProcessMemoryIndexer(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  host: MemoryIndexerHost;
  fetchDecryptedTranscriptPageAfterSeq?: (args: Readonly<{
    sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal;
  }>) => Promise<DecryptedTranscriptRow[]>;
}>): Promise<MemoryIndexerConnection> {
  const engine = await createMemoryIndexer({ ...params,
    resolveExternalReader: async agentId => {
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      try {
        const runtime = lease.registry.agentRuntimesByAgentId.get(agentId);
        return runtime?.isCurrent() && !runtime.retirementSignal.aborted ? runtime.externalSessions ?? null : null;
      } finally { await lease.release(); }
    },
    ...(params.fetchDecryptedTranscriptPageAfterSeq ? { deps: { fetchDecryptedTranscriptPageAfterSeq: params.fetchDecryptedTranscriptPageAfterSeq } } : {}) });
  return bindMemoryIndexerConnection(engine, {
    beforeRetire: () => engine.awaitModelInitialization(),
    afterOperation: signal => engine.runUntilSettled(signal),
  });
}

