import type { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { logger } from '@/ui/logger';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

type Reconcile = (sourceSessionId: string | null) => Promise<void>;

/** Reuses the captured Account feed and the daemon's bound receiver recovery. */
export function createRequesterSessionFollowSourceReconciliation(input: Readonly<{
  bootstrap: Pick<AdmittedRequesterSessionBootstrap, 'subscribeSessionFollowSources' | 'getBoundSessionId'>;
  sessionFollowRuleCache: ReturnType<typeof createAccountSessionFollowRuleCache>;
  isCurrent: () => Promise<boolean>;
}>) {
  let disposed = false;
  type Recovery = { sourceSessionId: string | null };
  let binding: { reconcile: Reconcile; signal: AbortSignal; running: boolean; pending: Recovery | null } | null = null;
  const release = input.bootstrap.subscribeSessionFollowSources(sourceSessionId => {
    const captured = binding;
    if (!captured || captured.signal.aborted || disposed) return;
    const destinationSessionId = input.bootstrap.getBoundSessionId();
    if (!destinationSessionId) return;
    const source = sourceSessionId === destinationSessionId ? null : sourceSessionId;
    const previous = captured.pending;
    captured.pending = { sourceSessionId: previous && previous.sourceSessionId !== source ? null : source };
    if (captured.running) return;
    captured.running = true;
    void (async () => {
      try {
        // Receiver progress and reconnects remain receiver-wide. Only unrelated
        // source hints require private-rule demand. Hints arriving during a pass
        // merge into one subsequent observation, without cancelling that pass.
        while (captured === binding && !captured.signal.aborted && !disposed && captured.pending) {
          const request = captured.pending;
          captured.pending = null;
          try {
            if (request.sourceSessionId !== null
              && !await input.sessionFollowRuleCache.hasEnabledSessionReceiver(destinationSessionId)) continue;
            if (!await input.isCurrent()) return;
            if (captured === binding && !captured.signal.aborted && !disposed) {
              await captured.reconcile(request.sourceSessionId);
            }
          } catch { if (!disposed) logger.warn('[Session Follow] Requester source recovery remains pending'); }
        }
      } finally { captured.running = false; }
    })();
  });
  return {
    bind: (reconcile: Reconcile, signal: AbortSignal) => {
      if (!disposed && !signal.aborted && binding?.signal !== signal) binding = { reconcile, signal, running: false, pending: null };
    },
    dispose: () => { disposed = true; binding = null; release(); },
  };
}
