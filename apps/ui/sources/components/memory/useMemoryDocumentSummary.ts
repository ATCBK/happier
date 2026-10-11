import * as React from 'react';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fetchDaemonMemoryDocumentSummary, type MemoryDocumentSummary } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { useMemorySearchProvider } from '@/sync/domains/memory/useMemorySearchProvider';

import type { MemoryDocumentSource } from './useMemoryDocument';

const UNAVAILABLE: MemoryDocumentSummary = { state: 'unavailable' };
const PENDING: MemoryDocumentSummary = { state: 'pending' };
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
  const account = useActiveServerAccountScope(view?.ref.serverId ?? serverId);
  const enabled = params.enabled !== false && source.status === 'ready' && !source.stale && view !== null;
  const provider = useMemorySearchProvider({ kind: 'exact', serverId: view?.ref.serverId ?? serverId },
    { enabled, corpora: DOCUMENTS });
  const target = provider.daemonTarget;
  const sessionId = params.scope?.type === 'session' ? params.scope.sessionId : null;
  const key = JSON.stringify([account?.accountId, target?.serverId, target?.machineId,
    view?.ref, view?.revision, sessionId, params.preparationBasis, source.status, source.stale]);
  const custody = source.draftCustody;
  const [loaded, setLoaded] = React.useState<Readonly<{ key: string; summary: MemoryDocumentSummary }> | null>(null);
  React.useEffect(() => {
    if (!enabled || !view || !target || !account || custody?.isCurrent() !== true) return;
    const controller = new AbortController();
    setLoaded({ key, summary: PENDING });
    void fetchDaemonMemoryDocumentSummary({ ...target, accountId: account.accountId,
      ref: view.ref, revision: view.revision, signal: controller.signal,
      scope: sessionId ? { type: 'session', sessionId } : { type: 'global' },
    }).then(summary => {
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary });
    }).catch(() => {
      if (!controller.signal.aborted && custody.isCurrent()) setLoaded({ key, summary: UNAVAILABLE });
    });
    return () => controller.abort();
  }, [account, custody, enabled, key, params.preparationBasis, sessionId, target, view]);
  if (!enabled || !target || !account || custody?.isCurrent() !== true) return UNAVAILABLE;
  return loaded?.key === key ? loaded.summary : PENDING;
}
