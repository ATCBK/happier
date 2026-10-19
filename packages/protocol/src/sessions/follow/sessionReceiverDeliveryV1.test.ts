import { describe, expect, it } from 'vitest';
import { resolveSessionReceiverDeliveryV1, type SessionReceiverDeliveryFactsV1 } from './sessionReceiverDeliveryV1.js';

const idle: SessionReceiverDeliveryFactsV1 = {
  archived: false, explicitStop: 'clear', availability: 'idle', sourceMaterial: 'available', muted: false, exchange: 'open',
};

describe('Session receiver delivery admission', () => {
  it('holds explicit Stop intent without interpreting inactive or unavailable as a person stop', () => {
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, explicitStop: 'held' }, intent: 'wake' }))
      .toEqual({ disposition: 'hold', reason: 'explicit_stop' });
    expect(resolveSessionReceiverDeliveryV1({ facts: idle, intent: 'wake' })).toEqual({ disposition: 'wake' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, availability: 'offline' }, intent: 'wake' }))
      .toEqual({ disposition: 'hold', reason: 'offline' });
  });

  it('keeps busy and quiet delivery at the next boundary and never requests steer', () => {
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, availability: 'busy' }, intent: 'wake' }))
      .toEqual({ disposition: 'next_turn' });
    expect(resolveSessionReceiverDeliveryV1({ facts: idle, intent: 'next_turn' })).toEqual({ disposition: 'next_turn' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, exchange: 'check_in' }, intent: 'next_turn' }))
      .toEqual({ disposition: 'next_turn' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, availability: 'busy', exchange: 'check_in' }, intent: 'wake' }))
      .toEqual({ disposition: 'next_turn' });
  });

  it('drops archived or muted sources before any wake, including returned answers', () => {
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, archived: true }, intent: 'wake', returnedAnswer: true }))
      .toEqual({ disposition: 'drop', reason: 'archived' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, muted: true }, intent: 'wake', returnedAnswer: true }))
      .toEqual({ disposition: 'drop', reason: 'muted' });
  });

  it('admits a returned answer without new exchange allowance while preserving Stop and source keys', () => {
    for (const exchange of ['check_in', 'stopped', 'unavailable'] as const) {
      expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, exchange }, intent: 'wake', returnedAnswer: true }))
        .toEqual({ disposition: 'wake' });
    }
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, exchange: 'check_in' }, intent: 'wake' }))
      .toEqual({ disposition: 'hold', reason: 'check_in' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, exchange: 'stopped' }, intent: 'wake' }))
      .toEqual({ disposition: 'drop', reason: 'exchange_stopped' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, sourceMaterial: 'locked' }, intent: 'wake', returnedAnswer: true }))
      .toEqual({ disposition: 'hold', reason: 'locked' });
    expect(resolveSessionReceiverDeliveryV1({ facts: { ...idle, explicitStop: 'held' }, intent: 'wake', returnedAnswer: true }))
      .toEqual({ disposition: 'hold', reason: 'explicit_stop' });
  });
});
