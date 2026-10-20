import { setTimeout as delay } from 'node:timers/promises';

import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';

export type TerminalEnrollmentHomeRetry = Readonly<{
  deadlineMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}>;

/** Only repeatable post-claim Home work belongs here; never replay the one-shot claim. */
export async function retryTerminalEnrollmentHomeOperation<T>(
  lifetime: TerminalEnrollmentHomeRetry,
  operation: () => Promise<T>,
): Promise<T> {
  while (true) {
    lifetime.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lifetime.signal?.throwIfAborted();
      const failure = classifyServerEndpointError(error);
      // A retired admission (409) is authoritative, not transient Home unavailability.
      if (!failure.retryable || failure.kind === 'generation_conflict') throw error;
      const remainingMs = lifetime.deadlineMs - Date.now();
      if (remainingMs <= 0) throw error;
      await delay(Math.min(failure.retryAfterMs ?? lifetime.pollIntervalMs, remainingMs), undefined,
        { signal: lifetime.signal });
      lifetime.signal?.throwIfAborted();
      // Preserve the last Home failure when its existing lifetime runs out.
      if (Date.now() >= lifetime.deadlineMs) throw error;
    }
  }
}
