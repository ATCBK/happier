import { describe, expect, it } from 'vitest';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { skillStatus, skillNeedsALook } from './skillStatus';

const day = 86_400_000, nowMs = 100 * day;
const item = SkillListItemV1Schema.parse({ skillId: 'review', name: 'review', description: null, revision: '1:1',
  rules: [], trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 0 }, provenance: { kind: 'written' },
  modified: false, updatePolicy: 'manual', createdAt: 40 * day, migratedFromContext: false, userInvocable: true, folderId: null });

describe('skill status usage truth', () => {
  it.each([
    { lastUsedAt: nowMs - 31 * day, observed: nowMs - 31 * day, createdAt: item.createdAt, unused: true },
    { lastUsedAt: nowMs - 29 * day, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: nowMs - 30 * day, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 10 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: true },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: nowMs - 5 * day, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 30 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: nowMs - 30 * day, unused: false },
    { lastUsedAt: undefined, observed: null, createdAt: item.createdAt, unused: false },
    { lastUsedAt: nowMs - 31 * day, observed: null, createdAt: item.createdAt, unused: false },
  ])('uses observed timestamps at the strict 30-day boundary ($unused)', ({ lastUsedAt, observed, createdAt, unused }) => {
    const current = { ...item, lastUsedAt, createdAt };
    expect(skillStatus(current, { nowMs, usageObservedSince: observed }).some(status => status.kind === 'unused')).toBe(unused);
    expect(skillStatus(current, { nowMs, usageObservedSince: observed }).some(status => status.kind === 'off')).toBe(true);
    expect(skillNeedsALook(current)).toBe(false);
  });
});
