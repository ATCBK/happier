/** Current facts supplied by the lifecycle, key, suppression and exchange owners. */
export type SessionReceiverDeliveryFactsV1 = Readonly<{
  archived: boolean;
  explicitStop: 'clear' | 'held' | 'unavailable';
  availability: 'idle' | 'busy' | 'offline' | 'unavailable';
  sourceMaterial: 'available' | 'locked';
  muted: boolean;
  exchange: 'open' | 'check_in' | 'stopped' | 'unavailable';
}>;

export type SessionReceiverDeliveryDecisionV1 =
  | Readonly<{ disposition: 'drop'; reason: 'archived' | 'muted' | 'exchange_stopped' }>
  | Readonly<{ disposition: 'hold'; reason: 'explicit_stop' | 'receiver_unavailable' | 'offline' | 'locked' | 'check_in' | 'exchange_unavailable' }>
  | Readonly<{ disposition: 'next_turn' }>
  | Readonly<{ disposition: 'wake' }>;

/**
 * Receiver admission is shared by addressed input, Follow and correlated returns.
 * `wake` admits an attempt; only the input owner can prove a new turn accepted it.
 */
export function resolveSessionReceiverDeliveryV1(input: Readonly<{
  facts: SessionReceiverDeliveryFactsV1;
  intent: 'wake' | 'next_turn';
  returnedAnswer?: boolean;
}>): SessionReceiverDeliveryDecisionV1 {
  const { facts } = input;
  if (facts.archived) return { disposition: 'drop', reason: 'archived' };
  if (facts.muted) return { disposition: 'drop', reason: 'muted' };
  if (facts.explicitStop === 'held') return { disposition: 'hold', reason: 'explicit_stop' };
  if (facts.explicitStop === 'unavailable') return { disposition: 'hold', reason: 'receiver_unavailable' };
  if (facts.sourceMaterial === 'locked') return { disposition: 'hold', reason: 'locked' };
  if (facts.availability === 'offline') return { disposition: 'hold', reason: 'offline' };
  if (facts.availability === 'unavailable') return { disposition: 'hold', reason: 'receiver_unavailable' };
  // Quiet supplements and inputs joining an active turn do not spend allowance.
  // Actual new-turn acceptance re-enters the exchange owner before a new effect.
  if (input.intent === 'next_turn' || facts.availability === 'busy') return { disposition: 'next_turn' };
  if (!input.returnedAnswer) {
    if (facts.exchange === 'stopped') return { disposition: 'drop', reason: 'exchange_stopped' };
    if (facts.exchange === 'check_in') return { disposition: 'hold', reason: 'check_in' };
    if (facts.exchange === 'unavailable') return { disposition: 'hold', reason: 'exchange_unavailable' };
  }
  return { disposition: 'wake' };
}
