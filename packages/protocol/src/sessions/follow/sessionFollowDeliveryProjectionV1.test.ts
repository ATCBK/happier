import { describe, expect, it } from 'vitest';

import { projectFollowDeliveryV1 } from './sessionFollowDeliveryProjectionV1.js';

const wake = { disposition: 'wake' } as const;

describe('projectFollowDeliveryV1', () => {
  it('keeps admission intent separate from actual provider acceptance', () => {
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake })).toEqual({ status: null, reason: null });
    expect(projectFollowDeliveryV1({ intent: 'next_turn', decision: { disposition: 'next_turn' } }))
      .toEqual({ status: null, reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      pendingStatus: { status: 'queued' } })).toEqual({ status: 'queued', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      acceptedTurn: { kind: 'newTurn', turnId: 'turn-1' }, acceptedTurnStartsNewTurn: true }))
      .toEqual({ status: 'woke', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'next_turn', decision: { disposition: 'next_turn' },
      acceptedTurn: { kind: 'newTurn', turnId: 'turn-1' }, acceptedTurnStartsNewTurn: true }))
      .toEqual({ status: 'next_turn', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      acceptedTurn: { kind: 'followUp', turnId: 'turn-1' }, acceptedTurnStartsNewTurn: true }))
      .toEqual({ status: 'woke', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      acceptedTurn: { kind: 'newTurn', turnId: 'turn-1' }, acceptedTurnStartsNewTurn: false }))
      .toEqual({ status: 'next_turn', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      acceptedTurn: { kind: 'newTurn', turnId: 'turn-1' } }))
      .toEqual({ status: null, reason: null });
  });

  it('reports receiver reasons separately from the delivery state', () => {
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'hold', reason: 'explicit_stop' } }))
      .toEqual({ status: null, reason: 'held' });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'hold', reason: 'offline' } }))
      .toEqual({ status: null, reason: 'offline' });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'hold', reason: 'locked' } }))
      .toEqual({ status: null, reason: 'locked' });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'drop', reason: 'archived' } }))
      .toEqual({ status: null, reason: 'archived' });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: { disposition: 'drop', reason: 'muted' } }))
      .toEqual({ status: null, reason: 'muted' });
  });

  it('does not turn an uncertain Pending outcome into a success', () => {
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      pendingStatus: { status: 'blocked', reason: 'delivery_outcome_uncertain' } }))
      .toEqual({ status: null, reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake,
      pendingStatus: { status: 'external_handoff' } }))
      .toEqual({ status: null, reason: null });
  });

  it('answers only from an actual correlated answer outcome', () => {
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake, replyOutcome: 'answer' }))
      .toEqual({ status: 'answered', reason: null });
    expect(projectFollowDeliveryV1({ intent: 'wake', decision: wake, replyOutcome: 'pass' }))
      .toEqual({ status: null, reason: null });
  });
});
