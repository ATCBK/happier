import { describe, expect, it } from 'vitest';
import { createSessionBrokerApplicationEvidence } from './sessionBrokerApplicationEvidence';

describe('Session broker application evidence', () => {
  it('keeps delayed request outcomes on their captured turn and retires them with the host', () => {
    let turnId: string | null = null;
    let current = true;
    const evidence = createSessionBrokerApplicationEvidence({ readActiveTurnId: () => turnId, isCurrent: () => current });
    const denial = { v: 1, resourceId: 'selected-resource', reasonCode: 'broker_unavailable' } as const;
    expect(evidence.beginRequest()).toBeUndefined(); // Startup discovery has no turn.
    turnId = 'first';
    const oldRequest = evidence.beginRequest();
    oldRequest?.(denial);
    expect(evidence.readDenial('first')).toEqual(denial);
    turnId = 'second';
    const newRequest = evidence.beginRequest();
    newRequest?.(denial);
    oldRequest?.(null); // Late old success must not erase the second turn's denial.
    oldRequest?.(denial); // Nor attribute an old refusal to its successor.
    expect(evidence.readDenial('first')).toBeNull();
    expect(evidence.readDenial('second')).toEqual(denial);
    newRequest?.(null);
    expect(evidence.readDenial('second')).toBeNull();
    newRequest?.(denial);
    current = false;
    expect(evidence.beginRequest()).toBeUndefined();
    expect(evidence.readDenial('second')).toBeNull();
  });
});
