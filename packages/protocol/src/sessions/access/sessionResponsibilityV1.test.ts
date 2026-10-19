import { describe, expect, it } from 'vitest';

import {
  SessionResponsibilityCandidatesRequestSchema,
  SessionResponsibilityCandidatesResponseSchema,
  SetSessionResponsibilityRequestSchema,
  SetSessionResponsibilityResponseSchema,
} from './sessionResponsibilityV1.js';
import { V2SessionRecordSchema } from '../control/contract.js';

describe('SetSessionResponsibilityRequestSchema', () => {
  it('accepts an explicit assignee and an explicit clear', () => {
    expect(SetSessionResponsibilityRequestSchema.parse({
      sessionId: 'session-1',
      responsibleAccountId: 'account-1',
    })).toEqual({ sessionId: 'session-1', responsibleAccountId: 'account-1' });

    expect(SetSessionResponsibilityRequestSchema.parse({
      sessionId: 'session-1',
      responsibleAccountId: null,
    })).toEqual({ sessionId: 'session-1', responsibleAccountId: null });
  });

  it('requires the desired value: an omitted assignee is not a clear', () => {
    expect(SetSessionResponsibilityRequestSchema.safeParse({ sessionId: 'session-1' }).success)
      .toBe(false);
  });

  it('rejects empty identifiers and unknown identity fields at this authority boundary', () => {
    expect(SetSessionResponsibilityRequestSchema.safeParse({
      sessionId: '',
      responsibleAccountId: 'account-1',
    }).success).toBe(false);
    expect(SetSessionResponsibilityRequestSchema.safeParse({
      sessionId: 'session-1',
      responsibleAccountId: '',
    }).success).toBe(false);
    expect(SetSessionResponsibilityRequestSchema.safeParse({
      sessionId: 'session-1',
      responsibleAccountId: 'account-1',
      accessLevel: 'admin',
    }).success).toBe(false);
    expect(SetSessionResponsibilityRequestSchema.safeParse({
      sessionId: 'session-1',
      responsibleAccountId: 'account-1',
      grantAccess: true,
    }).success).toBe(false);
  });
});

describe('SetSessionResponsibilityResponseSchema', () => {
  const aliceSummary = {
    kind: 'account' as const,
    accountId: 'account-1',
    firstName: 'Alice',
    lastName: 'Martin',
    username: 'alice',
    avatarUrl: null,
  };
  it('publishes the authoritative desired-state result for the shared Action', () => {
    expect(SetSessionResponsibilityResponseSchema.parse({ changed: false, responsibleAccountId: null, responsibleAccount: null, autoFollowed: false }))
      .toEqual({ changed: false, responsibleAccountId: null, responsibleAccount: null, autoFollowed: false });
    expect(SetSessionResponsibilityResponseSchema.parse({ changed: true, responsibleAccountId: 'account-1', responsibleAccount: aliceSummary, autoFollowed: true }))
      .toEqual({ changed: true, responsibleAccountId: 'account-1', responsibleAccount: { ...aliceSummary, name: 'Alice Martin' }, autoFollowed: true });
    expect(SetSessionResponsibilityResponseSchema.safeParse({
      responsibleAccountId: 'account-1', changed: true, responsibleAccount: aliceSummary, autoFollowed: true, assignedByAccountId: 'account-2',
    }).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({ responsibleAccountId: null, responsibleAccount: null }).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({}).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({ changed: false, responsibleAccountId: 'account-1', responsibleAccount: aliceSummary, autoFollowed: true }).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({ changed: true, responsibleAccountId: null, responsibleAccount: null, autoFollowed: true }).success).toBe(false);
  });

  it('rejects an unassigned id paired with a non-null summary and a mismatched summary', () => {
    expect(SetSessionResponsibilityResponseSchema.safeParse({
      changed: true,
      autoFollowed: false,
      responsibleAccountId: null,
      responsibleAccount: aliceSummary,
    }).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({
      changed: true,
      autoFollowed: false,
      responsibleAccountId: 'account-2',
      responsibleAccount: aliceSummary,
    }).success).toBe(false);
    expect(SetSessionResponsibilityResponseSchema.safeParse({
      changed: true,
      autoFollowed: false,
      responsibleAccountId: 'account-1',
      responsibleAccount: null,
    }).success).toBe(false);
  });
});

describe('SessionResponsibilityCandidatesRequestSchema', () => {
  it('accepts discussion mention discovery as a separate purpose', () => {
    expect(SessionResponsibilityCandidatesRequestSchema.parse({
      sessionId: 'session-1',
      purpose: 'mention',
    }).purpose).toBe('mention');
  });
  it('accepts the bounded search/pagination inputs', () => {
    expect(SessionResponsibilityCandidatesRequestSchema.parse({
      sessionId: 'session-1',
      purpose: 'assignment',
    })).toEqual({ sessionId: 'session-1', purpose: 'assignment' });

    const parsed = SessionResponsibilityCandidatesRequestSchema.parse({
      sessionId: 'session-1',
      purpose: 'assignment',
      query: 'ali',
      cursor: 'account-9',
      limit: 25,
    });
    expect(parsed.query).toBe('ali');
    expect(parsed.limit).toBe(25);

    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      query: 'x'.repeat(256),
      cursor: 'x'.repeat(512),
      limit: 100,
    }).success).toBe(true);
  });

  it('rejects an unauthorized purpose, an unbounded page and unknown fields', () => {
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'directory',
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      limit: 1000,
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      query: 'x'.repeat(257),
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      query: '',
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      cursor: 'x'.repeat(513),
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesRequestSchema.safeParse({
      sessionId: 'session-1',
      purpose: 'assignment',
      teamId: 'team-1',
    }).success).toBe(false);
  });
});

describe('SessionResponsibilityCandidatesResponseSchema', () => {
  it('projects neutral identity plus one bounded access hint', () => {
    const parsed = SessionResponsibilityCandidatesResponseSchema.parse({
      candidates: [{
        accountId: 'account-1',
        profile: { firstName: 'Alice', lastName: 'Martin', username: 'alice', avatarUrl: null },
        accessHint: 'edit',
      }],
      nextCursor: null,
    });
    expect(parsed.candidates[0]?.accountId).toBe('account-1');
    expect(parsed.candidates[0]?.accessHint).toBe('edit');
  });

  it('refuses to disclose grant topology through the candidate row', () => {
    expect(SessionResponsibilityCandidatesResponseSchema.safeParse({
      candidates: [{
        accountId: 'account-1',
        profile: { firstName: null, lastName: null, username: null, avatarUrl: null },
        teamId: 'team-1',
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(SessionResponsibilityCandidatesResponseSchema.safeParse({
      candidates: [{
        accountId: 'account-1',
        profile: { firstName: null, lastName: null, username: null, avatarUrl: null, email: 'a@b.c' },
      }],
      nextCursor: null,
    }).success).toBe(false);
  });
});

describe('V2SessionRecordSchema responsibility projection', () => {
  const baseRecord = {
    id: 'session-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 1,
    metadata: '{}',
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
  const aliceSummary = {
    kind: 'account' as const,
    accountId: 'account-1',
    firstName: 'Alice',
    lastName: null,
    username: 'alice',
    avatarUrl: null,
  };

  it('keeps omitted, explicit null and explicit assignee distinguishable', () => {
    const omitted = V2SessionRecordSchema.parse({ ...baseRecord });
    expect('responsibleAccountId' in omitted).toBe(false);
    expect('responsibleAccount' in omitted).toBe(false);

    const unassigned = V2SessionRecordSchema.parse({ ...baseRecord, responsibleAccountId: null, responsibleAccount: null });
    expect(unassigned.responsibleAccountId).toBeNull();
    expect(unassigned.responsibleAccount).toBeNull();

    const assigned = V2SessionRecordSchema.parse({ ...baseRecord, responsibleAccountId: 'account-1', responsibleAccount: aliceSummary });
    expect(assigned.responsibleAccountId).toBe('account-1');
    expect(assigned.responsibleAccount).toEqual({ ...aliceSummary, name: 'Alice' });
  });

  it('rejects a mismatched summary and an unassigned id with a non-null summary', () => {
    expect(V2SessionRecordSchema.safeParse({
      ...baseRecord,
      responsibleAccountId: null,
    }).success).toBe(false);
    expect(V2SessionRecordSchema.safeParse({
      ...baseRecord,
      responsibleAccountId: 'account-1',
    }).success).toBe(false);
    expect(V2SessionRecordSchema.safeParse({ ...baseRecord, responsibleAccountId: null, responsibleAccount: aliceSummary }).success)
      .toBe(false);
    expect(V2SessionRecordSchema.safeParse({
      ...baseRecord,
      responsibleAccountId: 'account-1',
      responsibleAccount: { ...aliceSummary, accountId: 'account-2' },
    }).success).toBe(false);
  });

  it('rejects an empty responsible Account identifier', () => {
    expect(V2SessionRecordSchema.safeParse({ ...baseRecord, responsibleAccountId: '' }).success)
      .toBe(false);
  });
});
