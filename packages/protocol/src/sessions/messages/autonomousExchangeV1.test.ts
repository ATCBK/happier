import { describe, expect, it } from 'vitest';

import {
  applyAutonomousExchangeAcceptedTurnV1,
  applyAutonomousExchangeControlV1,
  createAutonomousExchangeStateV1,
  readAutonomousExchangeAdmissionV1,
  type AutonomousExchangeStateV1,
} from './autonomousExchangeV1.js';

const initial: AutonomousExchangeStateV1 = {
  v: 1, observedStarts: 0, pauseAtStarts: null, stopped: false, afterTurns: 5,
};

describe('autonomous exchange from the original input', () => {
  it('uses the originating Discussion choice, preserving Never pause rather than falling back to the Account', () => {
    const never = createAutonomousExchangeStateV1(5, { afterTurns: null });
    expect(readAutonomousExchangeAdmissionV1({ ...never, observedStarts: 5 })).toBe('allow');
    const ownWindow = createAutonomousExchangeStateV1(5, { afterTurns: 12 });
    expect(readAutonomousExchangeAdmissionV1({ ...ownWindow, observedStarts: 5 })).toBe('allow');
    expect(readAutonomousExchangeAdmissionV1({ ...ownWindow, observedStarts: 12 })).toBe('check_in');
    expect(readAutonomousExchangeAdmissionV1({ ...createAutonomousExchangeStateV1(5), observedStarts: 5 })).toBe('check_in');
  });

  it('checks in after five distinct agent-caused accepted turn starts, including a starting follow-up', () => {
    let state = initial;
    for (const [turnId, deliveryKind] of [
      ['turn-1', 'newTurn'], ['turn-2', 'newTurn'], ['turn-3', 'followUp'],
      ['turn-4', 'newTurn'], ['turn-5', 'newTurn'],
    ] as const) {
      expect(readAutonomousExchangeAdmissionV1(state)).toBe('allow');
      state = applyAutonomousExchangeAcceptedTurnV1(state, {
        cause: 'agent_session', deliveryKind, turnId, startsNewTurn: true,
      });
    }
    expect(state.observedStarts).toBe(5);
    expect(readAutonomousExchangeAdmissionV1(state)).toBe('check_in');
  });

  it('does not count a retry, same-turn steer, quiet context, returned answer, or person intervention', () => {
    const accepted = applyAutonomousExchangeAcceptedTurnV1(initial, {
      cause: 'agent_session', deliveryKind: 'newTurn', turnId: 'first', startsNewTurn: true,
    });
    for (const fact of [
      { cause: 'agent_session', deliveryKind: 'newTurn', turnId: 'first', startsNewTurn: false },
      { cause: 'agent_session', deliveryKind: 'steer', turnId: 'first', startsNewTurn: false },
      { cause: 'quiet_context', deliveryKind: 'followUp', turnId: 'quiet', startsNewTurn: true },
      { cause: 'returned_answer', deliveryKind: 'followUp', turnId: 'answer', startsNewTurn: true },
      { cause: 'person', deliveryKind: 'newTurn', turnId: 'human', startsNewTurn: true },
    ] as const) {
      expect(applyAutonomousExchangeAcceptedTurnV1(accepted, fact)).toEqual(accepted);
    }
  });

  it('continues for configured N or ten more from observed starts, while Never pause keeps exchange control off', () => {
    const checkedIn: AutonomousExchangeStateV1 = { ...initial, observedStarts: 5, afterTurns: 3 };
    expect(readAutonomousExchangeAdmissionV1({ ...checkedIn, afterTurns: null })).toBe('allow');
    const continued = applyAutonomousExchangeControlV1(checkedIn, { kind: 'continue' });
    expect(continued.pauseAtStarts).toBe(8);
    expect(readAutonomousExchangeAdmissionV1(continued)).toBe('allow');
    const tenMore = applyAutonomousExchangeControlV1(checkedIn, { kind: 'continue_more_10' });
    expect(tenMore.pauseAtStarts).toBe(15);
    expect(readAutonomousExchangeAdmissionV1({ ...tenMore, observedStarts: 15 })).toBe('check_in');
    expect(readAutonomousExchangeAdmissionV1({ ...tenMore, stopped: true, afterTurns: null })).toBe('stopped');
  });

  it('keeps the originating Account choice on the root and applies later changes only to future starts', () => {
    const checkedIn: AutonomousExchangeStateV1 = { ...initial, observedStarts: 5 };
    expect(readAutonomousExchangeAdmissionV1(checkedIn)).toBe('check_in');
    expect(readAutonomousExchangeAdmissionV1({ ...checkedIn, afterTurns: null })).toBe('allow');
    expect(readAutonomousExchangeAdmissionV1({ ...checkedIn, afterTurns: 8 })).toBe('allow');
    expect(readAutonomousExchangeAdmissionV1({ ...checkedIn, afterTurns: 3 })).toBe('check_in');
    const continued = applyAutonomousExchangeControlV1(checkedIn, { kind: 'continue' });
    expect(continued.pauseAtStarts).toBe(10);
    expect(readAutonomousExchangeAdmissionV1({ ...continued, afterTurns: 2, observedStarts: 7 })).toBe('allow');
    expect(readAutonomousExchangeAdmissionV1({ ...continued, afterTurns: 2, observedStarts: 10 })).toBe('check_in');
  });

  it('stops future rooted starts without erasing observed starts or allowing later continuation', () => {
    const checkedIn: AutonomousExchangeStateV1 = { ...initial, observedStarts: 5 };
    const stopped = applyAutonomousExchangeControlV1(checkedIn, { kind: 'stop' });
    expect(stopped).toMatchObject({ stopped: true, observedStarts: 5 });
    expect(readAutonomousExchangeAdmissionV1(stopped)).toBe('stopped');
    expect(applyAutonomousExchangeControlV1(stopped, { kind: 'continue_more_10' })).toEqual(stopped);
  });
});
