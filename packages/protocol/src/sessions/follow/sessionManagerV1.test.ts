import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { readSessionLiveManagedSessionCountV1, readSessionManagerSessionIdV1, SessionManagedSessionsV1Schema, SessionManagerSetRequestV1Schema, SessionManagerSetResultV1Schema } from './sessionManagerV1.js';

describe('Session manager wire contract', () => {
  it('reads only the admitted manager identity and preserves missing projection semantics', () => {
    expect(readSessionManagerSessionIdV1({ manager: { sessionId: 'manager' } })).toBe('manager');
    for (const session of [undefined, null, {}, { manager: null }]) expect(readSessionManagerSessionIdV1(session)).toBeNull();
    expect(SessionManagerSetResultV1Schema.safeParse({ ok: false, error: 'manager_forbidden', reason: 'read', authority: 'admin' }).success).toBe(false);
  });
  it('requires an explicit expected lead and rejects unknown mutation authority', () => {
    expect(SessionManagerSetRequestV1Schema.parse({ managerSessionId: null, expectedManagerSessionId: 'lead' }))
      .toEqual({ managerSessionId: null, expectedManagerSessionId: 'lead' });
    expect(SessionManagerSetRequestV1Schema.safeParse({ managerSessionId: 'lead' }).success).toBe(false);
    expect(SessionManagerSetRequestV1Schema.safeParse({ managerSessionId: 'lead', expectedManagerSessionId: null, permission: 'admin' }).success).toBe(false);
  });

  it('accepts the three typed failures and the exact attachment result', () => {
    const validate = new Ajv2020({ strict: false, validateFormats: false })
      .compile(zodSchemaToJsonSchemaObject(SessionManagerSetResultV1Schema));
    for (const result of [
      { ok: false, error: 'manager_cycle' },
      { ok: false, error: 'manager_cas_conflict' },
      { ok: false, error: 'manager_forbidden', reason: 'pairwise' },
      { ok: true, sessionId: 'child', managerSessionId: 'lead', attachedAt: 42 },
      { ok: true, sessionId: 'child', managerSessionId: null, attachedAt: null },
    ]) {
      expect(SessionManagerSetResultV1Schema.safeParse(result).success).toBe(true);
      expect(validate(result)).toBe(true);
    }
    for (const result of [
      { ok: true, sessionId: 'child', managerSessionId: 'lead', attachedAt: null },
      { ok: true, sessionId: 'child', managerSessionId: null, attachedAt: 42 },
    ]) {
      expect(SessionManagerSetResultV1Schema.safeParse(result).success).toBe(false);
      expect(validate(result)).toBe(false);
    }
    expect(SessionManagerSetResultV1Schema.safeParse({ ok: false, error: 'manager_forbidden', reason: 'owner' }).success).toBe(false);
    expect(SessionManagerSetResultV1Schema.safeParse({ ok: true, sessionId: 'child', managerSessionId: null, attachedAt: null, permission: 'admin' }).success).toBe(false);
  });

  it('counts live sub-sessions as total without the archived reports, and reads a count with no archived field', () => {
    const counts = { total: 3, working: 1, needsYou: 0, stalled: 0 };
    expect(SessionManagedSessionsV1Schema.safeParse(counts).success).toBe(true);
    expect(SessionManagedSessionsV1Schema.safeParse({ ...counts, archived: 1 }).success).toBe(true);
    expect(readSessionLiveManagedSessionCountV1(counts)).toBe(3);
    expect(readSessionLiveManagedSessionCountV1({ ...counts, archived: 1 })).toBe(2);
    expect(readSessionLiveManagedSessionCountV1({ ...counts, total: 1, archived: 1 })).toBe(0);
    expect(readSessionLiveManagedSessionCountV1(null)).toBe(0);
  });
});
