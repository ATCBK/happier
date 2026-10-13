/** Poll counts track recovery history; only their numeric representation is bounded. */
export function isConversationPollFailureAttemptCount(
  value: unknown,
): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1;
}
