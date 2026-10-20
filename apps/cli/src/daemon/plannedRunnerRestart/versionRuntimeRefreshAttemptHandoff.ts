import { isDeepStrictEqual } from 'node:util';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '../types';

type Attempt<TCompletion> = Readonly<{
  promise: Promise<TCompletion>;
  sessionId: string;
  tracked: TrackedSession;
  timeoutMs: number | null | undefined;
  transientSpawnOptions: SpawnSessionOptions | undefined;
  settle: (completion: TCompletion) => void;
  takeTransientSpawnOptions: () => SpawnSessionOptions | undefined;
  transferToPid: (pid: number) => void;
}>;

export function createVersionRuntimeRefreshAttemptHandoff<TCompletion>(params: Readonly<{
  timeoutMs: number | null;
  timeoutCompletion: TCompletion;
  supersededCompletion: TCompletion;
  cancelledCompletion: TCompletion;
  lifetime?: Readonly<{ signal: AbortSignal; completion: TCompletion }>;
}>) {
  const attemptsBySessionAndPid = new Map<string, Attempt<TCompletion>>();
  const key = (sessionId: string, pid: number): string => `${sessionId}\u0000${pid}`;

  const settle = (sessionId: string, pid: number, completion: TCompletion): void => {
    const attemptKey = key(sessionId, pid);
    const attempt = attemptsBySessionAndPid.get(attemptKey);
    if (!attempt) return;
    attemptsBySessionAndPid.delete(attemptKey);
    attempt.settle(completion);
  };

  const lifetime = params.lifetime;
  lifetime?.signal.addEventListener('abort', () => {
    for (const [attemptKey, attempt] of attemptsBySessionAndPid) {
      attemptsBySessionAndPid.delete(attemptKey);
      attempt.settle(lifetime.completion);
    }
  }, { once: true });

  const create = (input: Readonly<{
    sessionId: string;
    previousPid: number;
    tracked: TrackedSession;
    transientSpawnOptions?: SpawnSessionOptions;
    /**
     * `null` delegates completion exclusively to the canonical respawn owner.
     * Omit this field to inherit the containing owner's completion policy.
     */
    timeoutMs?: number | null;
  }>): Readonly<{
    promise: Promise<TCompletion>;
    start: () => void;
    cancel: () => void;
    settle: (completion: TCompletion) => void;
  }> => {
    if (params.lifetime?.signal.aborted) {
      return { promise: Promise.resolve(params.lifetime.completion), start: () => {}, cancel: () => {}, settle: () => {} };
    }
    let currentPid = input.previousPid;
    let pendingTransientSpawnOptions = input.transientSpawnOptions;
    let resolved = false;
    let resolveCompletion!: (completion: TCompletion) => void;
    const promise = new Promise<TCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const timeoutMs =
      input.timeoutMs === undefined
        ? params.timeoutMs
        : input.timeoutMs;
    let timer: NodeJS.Timeout | null = null;
    const start = (): void => {
      if (resolved || timer || timeoutMs === null) return;
      timer = setTimeout(() => {
        settle(
          input.sessionId,
          currentPid,
          params.timeoutCompletion,
        );
      }, timeoutMs);
      timer.unref?.();
    };
    const settleAttempt = (completion: TCompletion) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolveCompletion(completion);
    };
    const attemptKey = key(input.sessionId, input.previousPid);
    attemptsBySessionAndPid.get(attemptKey)?.settle(params.supersededCompletion);
    attemptsBySessionAndPid.set(attemptKey, {
      promise,
      sessionId: input.sessionId,
      tracked: input.tracked,
      timeoutMs: input.timeoutMs,
      transientSpawnOptions: input.transientSpawnOptions,
      settle: settleAttempt,
      takeTransientSpawnOptions: () => {
        const value = pendingTransientSpawnOptions;
        pendingTransientSpawnOptions = undefined;
        return value;
      },
      transferToPid: (pid) => {
        currentPid = pid;
      },
    });
    const complete = (completion: TCompletion): void => {
      if (resolved) return;
      attemptsBySessionAndPid.delete(key(input.sessionId, currentPid));
      settleAttempt(completion);
    };
    return {
      promise,
      start,
      settle: complete,
      cancel: () => complete(params.cancelledCompletion),
    };
  };

  return {
    create,
    settle,
    settleSession: (sessionId: string, completion: TCompletion): void => {
      for (const [attemptKey, attempt] of attemptsBySessionAndPid) {
        if (attempt.sessionId !== sessionId) continue;
        attemptsBySessionAndPid.delete(attemptKey);
        attempt.settle(completion);
      }
    },
    hasPending: (): boolean => attemptsBySessionAndPid.size > 0,
    has: (sessionId: string, pid: number, tracked?: TrackedSession): boolean => {
      const attempt = attemptsBySessionAndPid.get(key(sessionId, pid));
      return !!attempt && (tracked === undefined || attempt.tracked === tracked);
    },
    join: (input: Readonly<{
      sessionId: string;
      previousPid: number;
      tracked: TrackedSession;
      transientSpawnOptions?: SpawnSessionOptions;
      timeoutMs?: number | null;
    }>): Promise<TCompletion> | null => {
      const timeoutMs = input.timeoutMs;
      const attempt = attemptsBySessionAndPid.get(key(input.sessionId, input.previousPid));
      // Source cutovers carry callback-owned currentness beyond a spawn target. Their existing
      // pending-cutover owner decides equivalence; a public refresh cannot acknowledge that work.
      if (timeoutMs === null || !attempt || attempt.timeoutMs !== timeoutMs) return null;
      if (attempt.tracked !== input.tracked) return null;
      if (!isDeepStrictEqual(attempt.transientSpawnOptions, input.transientSpawnOptions)) return null;
      return attempt.promise;
    },
    takeTransientSpawnOptions: (sessionId: string, pid: number): SpawnSessionOptions | undefined => {
      return attemptsBySessionAndPid.get(key(sessionId, pid))?.takeTransientSpawnOptions();
    },
    transferPid: (sessionId: string, fromPid: number, toPid: number): void => {
      const fromKey = key(sessionId, fromPid);
      const attempt = attemptsBySessionAndPid.get(fromKey);
      if (!attempt) return;
      attemptsBySessionAndPid.delete(fromKey);
      const toKey = key(sessionId, toPid);
      attemptsBySessionAndPid.get(toKey)?.settle(params.supersededCompletion);
      attempt.transferToPid(toPid);
      attemptsBySessionAndPid.set(toKey, attempt);
    },
  };
}
