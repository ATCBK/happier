import { describe, expect, it } from 'vitest';

import {
  SessionPendingAdmissionSettlementRequestV1Schema,
  SessionPendingAdmissionSettlementResponseV1Schema,
} from './sessionPendingAdmissionSettlementV1.js';

const base = {
  v: 1 as const,
  sessionId: 'session-target',
  localId: 'plugin-input-v1:abc',
};

describe('Session Pending admission settlement V1', () => {
  it('carries only host-derived encrypted equality for an admitted target replacement', () => {
    const decision = { kind: 'admit', finalContent: { t: 'encrypted', c: 'final-cipher' }, requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } };
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base, decision }).success).toBe(true);
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base, decision: { ...decision, finalContent: { t: 'plain', v: {} } } }).success).toBe(false);
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base, decision: { ...decision, requestEqualityEvidenceV1: { kind: 'plainDigest', digest: 'A'.repeat(43) } } }).success).toBe(false);
  });
  it('accepts one strict admitted final envelope plus server-validation facts', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.parse({
      ...base,
      decision: {
        kind: 'admit',
        finalContent: {
          t: 'plain',
          v: { role: 'user', meta: { happierInputAuthorityV1: { v: 1 } } },
        },
        validation: {
          sourceSession: { sourceSessionId: 'session-source', sourceTurnId: 'turn-source', sourceInputId: 'input-source', via: 'action' },
          automation: { automationId: 'automation-1', runId: 'run-1' },
        },
      },
    })).toMatchObject({ decision: { kind: 'admit', validation: { sourceSession: {
      sourceSessionId: 'session-source', sourceTurnId: 'turn-source', sourceInputId: 'input-source', via: 'action',
    } } } });
  });

  it('requires the exact source Session transport when settlement carries source correlation', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_untrusted_assertion',
        validation: {
          sourceSession: { sourceSessionId: 'session-source', sourceTurnId: 'turn-source' },
        },
      },
    }).success).toBe(false);
  });

  it('carries protected returned-answer cause separately from descriptive source text', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.parse({
      ...base,
      decision: { kind: 'admit', finalContent: { t: 'encrypted', c: 'answer' },
        validation: { returnedAnswer: { requestSessionId: 'requester-session',
          requestLocalId: 'request-input', outcome: 'answer', delivery: 'wake' } } },
    })).toMatchObject({ decision: { validation: { returnedAnswer: {
      requestSessionId: 'requester-session', requestLocalId: 'request-input', delivery: 'wake',
    } } } });
  });

  it('carries only a positive current Account check-in choice or explicit Never pause', () => {
    const decision = { kind: 'admit', finalContent: { t: 'encrypted', c: 'input' },
      validation: { autonomousCheckIn: { afterTurns: 17 } } };
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base, decision }).success).toBe(true);
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base,
      decision: { ...decision, validation: { autonomousCheckIn: { afterTurns: null } } },
    }).success).toBe(true);
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({ ...base,
      decision: { ...decision, validation: { autonomousCheckIn: { afterTurns: 0 } } },
    }).success).toBe(false);
  });

  it('accepts only typed durable rejection without final content', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.parse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_permission_ceiling_rejected',
      },
    })).toEqual({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_permission_ceiling_rejected',
      },
    });
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'free-form',
        finalContent: { t: 'plain', v: {} },
      },
    }).success).toBe(false);
  });

  it('returns only terminal admission truth', () => {
    expect(SessionPendingAdmissionSettlementResponseV1Schema.parse({
      v: 1,
      result: { status: 'accepted', localId: base.localId },
    })).toEqual({
      v: 1,
      result: { status: 'accepted', localId: base.localId },
    });
  });
});
