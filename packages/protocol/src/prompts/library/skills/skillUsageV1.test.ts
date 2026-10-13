import { describe, expect, it } from 'vitest';
import { PromptLibraryRecordV1Schema, StoredPromptLibraryRecordV1Schema } from '../promptLibraryRowsV1.js';
import { emptyPromptLibraryRecordV1, PROMPT_LIBRARY_RETAINED_ROOTS_V1 } from '../promptLibraryCatalogV1.js';
import { AgentSessionRuntimeEventSchema } from '../../../runtime/agentSessionV1.js';
import { planSkillUsageWriteV1, readSkillUsageRowV1, SKILL_USAGE_WRITE_INTERVAL_MS_V1 } from './skillUsageV1.js';

describe('Account skill-use evidence', () => {
  it('writes absent and day-old uses without pruning history or changing newer observations', () => {
    const nowMs = SKILL_USAGE_WRITE_INTERVAL_MS_V1 * 2;
    const row = { v: 1 as const, lastUsedAt: { recent: nowMs - 1, due: nowMs - SKILL_USAGE_WRITE_INTERVAL_MS_V1,
      future: nowMs + 1, deleted: 1 } };
    expect(planSkillUsageWriteV1({ row, skillIds: ['recent', 'future'], nowMs })).toBeNull();
    expect(planSkillUsageWriteV1({ row, skillIds: ['new', 'new', 'due', 'recent'], nowMs })).toEqual({
      v: 1, lastUsedAt: { ...row.lastUsedAt, new: nowMs, due: nowMs },
    });
    expect(planSkillUsageWriteV1({ row: { v: 1, lastUsedAt: {} }, skillIds: ['__proto__', 'constructor'], nowMs }))
      .toEqual({ v: 1, lastUsedAt: { ['__proto__']: nowMs, constructor: nowMs } });
    expect(readSkillUsageRowV1({ v: 1, lastUsedAt: { kept: nowMs }, unknown: true }))
      .toEqual({ v: 1, lastUsedAt: { kept: nowMs } });
    expect(readSkillUsageRowV1({ v: 1, lastUsedAt: { invalid: -1 } })).toBeNull();
  });
  it('admits its own strict Account row and tolerant stored projection', () => {
    const record = { key: 'skill-usage', value: { v: 1, lastUsedAt: { 'library:review': 100 } } };
    expect(PromptLibraryRecordV1Schema.safeParse(record).success).toBe(true);
    expect(StoredPromptLibraryRecordV1Schema.parse({ ...record, future: true,
      value: { ...record.value, future: { retained: true } } })).toEqual(record);
    expect(PromptLibraryRecordV1Schema.safeParse({ ...record, value: { ...record.value, future: true } }).success).toBe(false);
    expect(PROMPT_LIBRARY_RETAINED_ROOTS_V1).toHaveProperty('skill-usage', null);
    expect(emptyPromptLibraryRecordV1('skill-usage')).toEqual({ key: 'skill-usage', value: { v: 1, lastUsedAt: {} } });
  });

  it('admits native evidence without granting unknown fields trusted meaning', () => {
    const event = { kind: 'skill-usage', sequence: 1, sessionId: 'session', turnId: 'turn', emittedAtMs: 100,
      skills: [{ name: 'happier:review' }, { name: 'review', path: '/private/skills/review/SKILL.md' }] };
    expect(AgentSessionRuntimeEventSchema.safeParse(event).success).toBe(true);
    expect(AgentSessionRuntimeEventSchema.safeParse({ ...event, authority: 'account' }).success).toBe(false);
    expect(AgentSessionRuntimeEventSchema.safeParse({ ...event, skills: [{ name: 'review', skillId: 'injected' }] }).success).toBe(false);
  });
});
