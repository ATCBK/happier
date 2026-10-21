import type { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { logger } from '@/ui/logger';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

/** Reuses the captured Account feed and the daemon's bound receiver recovery. */
export function createRequesterSessionFollowSourceReconciliation(input: Readonly<{
  bootstrap: Pick<AdmittedRequesterSessionBootstrap, 'subscribeSessionFollowSources' | 'getBoundSessionId'>;
  sessionFollowRuleCache: ReturnType<typeof createAccountSessionFollowRuleCache>;
  isCurrent: () => Promise<boolean>;
}>) {
  let disposed = false;
  let binding: Readonly<{ reconcile: (sourceSessionId: string | null) => Promise<void>; signal: AbortSignal }> | null = null;
  const release = input.bootstrap.subscribeSessionFollowSources(sourceSessionId => {
    const captured = binding;
    if (!captured || captured.signal.aborted || disposed) return;
    void (async () => {
      const destinationSessionId = input.bootstrap.getBoundSessionId();
      // Receiver progress/turn changes and reconnects re-observe all of its
      // configured sources. Private-rule discovery only filters unrelated
      // source changes; it cannot exclude manager or explicit Follow custody.
      if (!destinationSessionId) return;
      if (sourceSessionId !== null && sourceSessionId !== destinationSessionId
        && !await input.sessionFollowRuleCache.hasEnabledSessionReceiver(destinationSessionId)) return;
      if (!await input.isCurrent()) return;
      if (captured === binding && !captured.signal.aborted) {
        await captured.reconcile(sourceSessionId === destinationSessionId ? null : sourceSessionId);
      }
    })().catch(() => { if (!disposed) logger.warn('[Session Follow] Requester source recovery remains pending'); });
  });
  return {
    bind: (reconcile: (sourceSessionId: string | null) => Promise<void>, signal: AbortSignal) => {
      if (!disposed && !signal.aborted && binding?.signal !== signal) binding = { reconcile, signal };
    },
    dispose: () => { disposed = true; binding = null; release(); },
  };
}
