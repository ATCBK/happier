import * as React from 'react';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fetchDaemonMemoryDocumentSummary, type MemoryDocumentSummary } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import type { MemoryDocumentSource } from './useMemoryDocument';

const UNAVAILABLE: MemoryDocumentSummary = { state: 'unavailable' };
const DOCUMENTS = ['documents'] as const;

/** One cancellable read of the existing daemon admission owner, not a retained preparation. */
export function useMemoryDocumentSummary(params: Readonly<{
  source: MemoryDocumentSource;
  serverId: string;
  scope?: MemorySearchScope;
  /** Existing context rows changing invalidate the read even when the document revision does not. */
  preparationBasis?: string;
  enabled?: boolean;
}>): MemoryDocumentSummary {
  const { source, serverId } = params;
  const view = source.view;
  const sessionId = params.scope?.type === 'session' ? params.scope.sessionId : null;
  const originAccount = useActiveServerAccountScope(serverId);
  const custody = source.draftCustody;
  // A Session id belongs to its origin Home, even when its prepared document is foreign.
  // A document page instead uses the Account admitted by its qualified read.
  const account = sessionId ? originAccount : custody?.scope;
  const enabled = params.enabled !== false && source.status === 'ready' && !source.stale && view !== null;
  const provider = useMemorySearchProvider({ kind: 'exact', serverId: account?.serverId ?? serverId },
    { enabled, corpora: DOCUMENTS });
  const target = provider.daemonTarget;
  const selectedTarget = provider.selectedDaemonTarget;
  const unavailableMachine = React.useMemo<MemoryDocumentSummary>(() => selectedTarget && account
    && areServerProfileIdentifiersEquivalent(selectedTarget.serverId, account.serverId)
    ? { state: 'unavailable', cause: { reason: 'machine_unavailable', target: selectedTarget } }
    : UNAVAILABLE, [account, selectedTarget]);
  // An admitted status operation follows its caller's lifetime and may not answer.
  // Unknown counts are unavailable now, not a promise that a loading row will finish.
  // Keep that same read alive so a late answer can still supply the counts.
  const awaitingStatus = React.useMemo<MemoryDocumentSummary>(() => target
    ? { state: 'unavailable', cause: { reason: 'status_pending', target } }
    : UNAVAILABLE, [target]);
  const key = JSON.stringify([account?.serverId, account?.accountId, target?.serverId, target?.machineId,
    view?.ref, view?.revision, sessionId, params.preparationBasis, source.status, source.stale]);
  const [loaded, setLoaded] = React.useState<Readonly<{ key: string; summary: MemoryDocumentSummary }> | null>(null);
  React.useEffect(() => {
    if (!enabled || !view || !target || !account || custody?.isCurrent() !== true) return;
    const controller = new AbortController();
    setLoaded({ key, summary: awaitingStatus });
    void fetchDaemonMemoryDocumentSummary({ ...target, accountId: account.accountId,
      ref: view.ref, revision: view.revision, signal: controller.signal,
      scope: sessionId ? { type: 'session', sessionId } : { type: 'global' },
    }).then(summary => {
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary: summary.state === 'pending'
        ? { state: 'unavailable', cause: { reason: 'coverage_pending', target } }
        : summary });
    }).catch((error: unknown) => {
      const errorCode = readRpcErrorCode(error);
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary: { state: 'unavailable', cause: {
        reason: 'status_failed', target, ...(errorCode ? { errorCode } : {}),
      } } });
    });
    return () => controller.abort();
  }, [account, awaitingStatus, custody, enabled, key, params.preparationBasis, sessionId, target, view]);
  if (!enabled || !account || custody?.isCurrent() !== true) return UNAVAILABLE;
  if (!target) return unavailableMachine;
  return loaded?.key === key ? loaded.summary : awaitingStatus;
}
