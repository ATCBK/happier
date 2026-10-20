import { AsyncLocalStorage } from 'node:async_hooks';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { resolveOfflineReconnectionBackoffDelayMs } from '@/api/offline/serverConnectionErrors';
import { delayUnrefAbortable } from '@/utils/time';

import type { WebLatencyTracePoint } from '../externalActions/webLatencyTrace';

/** Unavailable Home evidence is not a rejected requester. Keep the existing
 * runner failure/respawn policy's retryable disposition and expose only a safe code. */
export function rethrowRequesterHomeReadFailure(error: unknown): void {
  if (isPluginError(error) && error.code === 'project_requester_home_unavailable') throw error;
  const unavailableActionRead = error !== null && typeof error === 'object'
    && 'ok' in error && error.ok === false
    && 'errorCode' in error && error.errorCode === 'server_unreachable';
  if (unavailableActionRead || classifyServerEndpointError(error).retryable) {
    throw new PluginError({ code: 'project_requester_home_unavailable',
      retryable: true,
      message: 'Requester Home is temporarily unavailable. Retry when it is available.' });
  }
}

/** Only preparation reads may re-enter here, never an admitted Action effect.
 * The accepted Action owns the lifetime; the shared backoff supplies pacing,
 * without adding a competing request deadline or attempt ceiling. Callers
 * without that lifetime retain their existing failure/recovery owner.
 */
export async function readRequesterHomeWithinActionLifetime<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await read();
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      try { rethrowRequesterHomeReadFailure(error); }
      catch (classified) {
        if (!isPluginError(classified) || classified.code !== 'project_requester_home_unavailable'
          || classified.retryable !== true) throw classified;
        await delayUnrefAbortable(resolveOfflineReconnectionBackoffDelayMs(++failures), signal);
        continue;
      }
      throw error;
    }
  }
}

export type RequesterCurrentnessObservation = Readonly<{ pending: Promise<boolean>; trace?: WebLatencyTracePoint }>;

export const requesterCurrentnessCheckpoint = new AsyncLocalStorage<{
  active: boolean;
  observations: Map<object, RequesterCurrentnessObservation>;
}>();

/** Preparation's nested readers prove the same requester fact. Share
 * that observation only until this checkpoint ends; each effect checkpoint
 * starts fresh, including when it interrupts a preparation for setup/review.
 * Local retirement and encryption-observation fences are still checked by
 * every reader. This does not retain authority between preparations or later
 * credential requests.
 */
export async function runWithRequesterSessionCurrentnessCheckpoint<T>(
  work: () => Promise<T>,
  options?: Readonly<{ readOnly: true }>,
): Promise<T> {
  const parent = requesterCurrentnessCheckpoint.getStore();
  // A nested read-only catalog preparation belongs to the containing bounded
  // observation. Effects still open fresh checkpoints by default, or leave
  // preparation explicitly; neither may inherit a settled read observation.
  if (options?.readOnly && parent?.active) return await work();
  parent?.observations.clear();
  const checkpoint = { active: true, observations: new Map<object, RequesterCurrentnessObservation>() };
  return await requesterCurrentnessCheckpoint.run(checkpoint, async () => {
    try { return await work(); }
    finally {
      checkpoint.active = false;
      checkpoint.observations.clear();
      parent?.observations.clear();
    }
  });
}

/** Catalog transfer can promote Secrets or write source rows while satisfying
 * a read. Its incumbent effect checks must remain fresh, outside preparation
 * reuse; returning to preparation must not resurrect the earlier observation.
 */
export async function runWithoutRequesterSessionCurrentnessCheckpoint<T>(work: () => Promise<T>): Promise<T> {
  const parent = requesterCurrentnessCheckpoint.getStore();
  parent?.observations.clear();
  try { return await requesterCurrentnessCheckpoint.exit(work); }
  finally { parent?.observations.clear(); }
}
