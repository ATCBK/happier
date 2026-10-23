import { MAX_CONVERSATION_RECEIVE_WAIT_MS } from '@happier-dev/channels-protocol/v1';

/**
 * The one Channels retry-delay curve. Ingress obligations and outward delivery
 * custody share the growing delay policy: two copies of
 * this formula had already drifted at `attemptCount === 0`, where the
 * unclamped exponent produced half the base delay.
 *
 * A provider-supplied `retryAfterMs` still wins where the caller has one; this
 * is only the default a caller falls back to.
 */
const CONVERSATION_RETRY_BASE_DELAY_MS = 1_000;

export function conversationRetryDelayMs(attemptCount: number): number {
  return Math.min(
    CONVERSATION_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)),
    // Failure recovery waits at most one healthy supervisor receive window.
    MAX_CONVERSATION_RECEIVE_WAIT_MS,
  );
}
