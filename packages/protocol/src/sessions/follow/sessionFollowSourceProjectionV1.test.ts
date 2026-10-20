import { describe, expect, it } from 'vitest';
import { SessionFollowSourceProjectionRequestV1Schema } from './sessionFollowSourceProjectionV1.js';

describe('Session Follow source projection wire contract', () => {
  it('pages original manager publications with attachment currentness', () => {
    const request = { v: 1, sourceSessionId: 'source', relation: 'manager', attachedAt: 123,
      readMode: 'incremental', afterTranscriptSeq: 1, observedTranscriptSeq: 1000, limit: 500 };
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse(request).success).toBe(true);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ ...request, attachedAt: undefined }).success).toBe(false);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ ...request, readMode: 'initial_current_snapshot' }).success).toBe(false);
  });
  it('uses the existing transcript transport page bound and rejects extra authority fields', () => {
    const base = { v: 1, sourceSessionId: 'source', afterTranscriptSeq: 1, observedTranscriptSeq: 3, limit: 500 };
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse(base).success).toBe(true);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ ...base, limit: 501 }).success).toBe(false);
    expect(SessionFollowSourceProjectionRequestV1Schema.safeParse({ ...base, destinationSessionId: 'forged' }).success).toBe(false);
  });
});
