import { startMemoryWorker as startDaemonMemoryWorker } from '../memoryWorker';
import { connectInProcessMemoryIndexer } from './inProcessMemoryIndexer';

/** Replace only the OS process placement; exercise the real daemon and indexer. */
export function startMemoryWorker(params: Parameters<typeof startDaemonMemoryWorker>[0]) {
  return startDaemonMemoryWorker({ ...params, deps: { ...params.deps,
    connectIndexer: params.deps?.connectIndexer ?? (host => connectInProcessMemoryIndexer({
      credentials: params.credentials, machineId: params.machineId, host,
      fetchDecryptedTranscriptPageAfterSeq: params.deps?.fetchDecryptedTranscriptPageAfterSeq,
    })),
  } });
}
