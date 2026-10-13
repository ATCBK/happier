import { describe, expect, it } from 'vitest';
import { deriveSkillTrustV1 } from './skillTrustV1.js';
import { estimateSkillCostV1 } from './skillCostV1.js';

describe('skill facts', () => {
  it('derives trust from the existing executable mode', () => {
    expect(deriveSkillTrustV1([{ path: 'SKILL.md' }])).toBe('text_only');
    expect(deriveSkillTrustV1([{ path: 'SKILL.md', unixMode: null }, { path: 'notes.txt' }])).toBe('has_files');
    expect(deriveSkillTrustV1([{ path: 'SKILL.md' }, { path: 'script', unixMode: 0o755 }])).toBe('runs_scripts');
  });
  it('separates always visible description cost from the loaded instruction body', () => {
    expect(estimateSkillCostV1('---\nname: x\ndescription: Four\n---\nEight888')).toEqual({ descriptionTokens: 1, bodyTokens: 2 });
  });
});
