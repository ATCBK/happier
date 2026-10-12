import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';

export type RestartCompletionWaiter = Readonly<{
  promise: Promise<RestartSessionRunnerCompletion>;
  cancel: () => void;
}>;

export type RestartCompletionWaiters = Readonly<{
  /** Registers the completion for a restart of `previousPid`, superseding any earlier waiter for it. */
  create: (sessionId: string, previousPid: number) => RestartCompletionWaiter;
  /** Returns the in-flight completion for a restart of `previousPid`, if one is pending. */
  join: (sessionId: string, previousPid: number) => Promise<RestartSessionRunnerCompletion> | null;
  settle: (sessionId: string, previousPid: number, completion: RestartSessionRunnerCompletion) => void;
}>;

type PendingWaiter = Readonly<{
  promise: Promise<RestartSessionRunnerCompletion>;
  settle: (completion: RestartSessionRunnerCompletion) => void;
}>;

const CANCELLED_BEFORE_SIGNAL_REASON = 'cancelled_before_signal';

/** True when the restart behind this completion was abandoned before its runner was ever signalled. */
export function isRestartCancelledBeforeSignal(completion: RestartSessionRunnerCompletion): boolean {
  return completion.ok === false
    && completion.diagnostics?.respawnTerminalReason === CANCELLED_BEFORE_SIGNAL_REASON;
}

function waiterKey(sessionId: string, previousPid: number): string {
  return `${sessionId}\u0000${previousPid}`;
}

/**
 * Tracks the completion of planned runner restarts per (session, previous pid) so a restart request can await
 * the respawn that its signal triggers. Completions are settled by the respawn manager, cancelled by a request
 * that never signalled, or timed out after `timeoutMs`.
 */
export function createRestartCompletionWaiters(params: Readonly<{ timeoutMs: number }>): RestartCompletionWaiters {
  const waiters = new Map<string, PendingWaiter>();

  const settle = (sessionId: string, previousPid: number, completion: RestartSessionRunnerCompletion): void => {
    const key = waiterKey(sessionId, previousPid);
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    waiter.settle(completion);
  };

  const create = (sessionId: string, previousPid: number): RestartCompletionWaiter => {
    const key = waiterKey(sessionId, previousPid);
    let resolved = false;
    let resolveCompletion!: (completion: RestartSessionRunnerCompletion) => void;
    const promise = new Promise<RestartSessionRunnerCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const timer = setTimeout(() => {
      settle(sessionId, previousPid, {
        ok: false,
        status: 'partial_failure',
        diagnostics: { respawnTerminalReason: 'timeout', timeoutMs: params.timeoutMs },
      });
    }, params.timeoutMs) as NodeJS.Timeout & { unref?: () => void };
    timer.unref?.();
    const settleOnce = (completion: RestartSessionRunnerCompletion) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolveCompletion(completion);
    };
    waiters.get(key)?.settle({
      ok: false,
      status: 'partial_failure',
      diagnostics: { respawnTerminalReason: 'superseded_waiter' },
    });
    const pending: PendingWaiter = { promise, settle: settleOnce };
    waiters.set(key, pending);
    return {
      promise,
      cancel: () => {
        if (resolved) return;
        if (waiters.get(key) === pending) waiters.delete(key);
        settleOnce({
          ok: false,
          status: 'partial_failure',
          diagnostics: { respawnTerminalReason: CANCELLED_BEFORE_SIGNAL_REASON },
        });
      },
    };
  };

  const join = (sessionId: string, previousPid: number): Promise<RestartSessionRunnerCompletion> | null =>
    waiters.get(waiterKey(sessionId, previousPid))?.promise ?? null;

  return { create, join, settle };
}
