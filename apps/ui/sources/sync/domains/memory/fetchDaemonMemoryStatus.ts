import { MemoryStatusV1Schema, type MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { MemoryDocumentRevision } from '@/sync/ops/promptLibrary/memoryDocuments';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export async function fetchDaemonMemoryStatus(args: Readonly<{
  serverId: string | null | undefined;
  accountId?: string | null;
  machineId: string | null | undefined;
  timeoutMs?: number;
  scope?: MemorySearchScope;
  /**
   * Caller cancellation, handed to the incumbent machine-RPC cancellation path so a
   * superseded status probe stops waiting locally and relays the cancel.
   */
  signal?: AbortSignal;
}>): Promise<MemoryStatusV1 | null> {
  const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
  const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
  const accountId = typeof args.accountId === 'string' ? args.accountId.trim() : '';
  if (!serverId || !machineId || (args.accountId !== undefined && !accountId)) return null;

  const raw = await machineRpcWithServerScope<unknown, unknown>({
    machineId,
    serverId,
    ...(accountId ? { accountId, preferScoped: true } : {}),
    method: RPC_METHODS.DAEMON_MEMORY_STATUS,
    payload: args.scope ? { scope: args.scope } : {},
    // Scoped status performs the same fresh admission as search, under the caller's lifetime.
    ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : { operationTimeoutMs: null }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return MemoryStatusV1Schema.parse(raw);
}

export type MemoryDocumentSummary = Readonly<{
  state: 'ready'; indexedFactCount: number; loadedFactCount?: number;
}> | Readonly<{
  state: 'pending' | 'unavailable';
  /** Summary availability, not a deadline or a claim that the remote request stopped. */
  cause?: Readonly<{
    /** No Memory Machine is chosen for this Home: nothing was asked, and choosing one is the fix. */
    reason: 'machine_not_chosen';
  }> | Readonly<{
    /** The entry carrying this document is switched off: nothing is indexed for it, so nothing is read. */
    reason: 'not_in_use';
  }> | Readonly<{
    reason: 'machine_unavailable' | 'status_pending' | 'coverage_pending' | 'status_failed';
    target: Readonly<{ serverId: string; machineId: string }>;
    errorCode?: string;
  }>;
}>;

/** Select only the displayed revision from the daemon's fresh admitted scope. */
export async function fetchDaemonMemoryDocumentSummary(args: Parameters<typeof fetchDaemonMemoryStatus>[0] & Readonly<{
  scope: MemorySearchScope;
  ref: PromptDocArtifactRefV1;
  revision: MemoryDocumentRevision;
}>): Promise<MemoryDocumentSummary> {
  const status = await fetchDaemonMemoryStatus(args);
  const documents = status?.documents;
  if (!documents || documents.state === 'unavailable') return { state: 'unavailable' };
  if (documents.state === 'pending') return { state: 'pending' };
  const document = documents.facts.find(fact => fact.ref.serverId === (args.ref.serverId ?? args.serverId)
    && fact.ref.artifactId === args.ref.artifactId);
  if (!document) return { state: 'unavailable' };
  if (document.revision.headerVersion !== args.revision.headerVersion
    || document.revision.bodyVersion !== args.revision.bodyVersion) return { state: 'pending' };
  return { state: 'ready', indexedFactCount: document.indexedFactCount,
    ...(document.loadedFactCount === undefined ? {} : { loadedFactCount: document.loadedFactCount }) };
}
