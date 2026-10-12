import { describe, expect, it } from 'vitest';
import * as selection from './sessionCapabilitySelectionV1.js';

describe('session capability selection equivalence', () => {
  it('treats omission as each kind default and respects skill differences', () => {
    const emptySkills = { v: 1 as const, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: [] };
    expect(selection.areSessionCapabilitySelectionsEquivalentV1(undefined, { skills: emptySkills })).toBe(true);
    expect(selection.areSessionCapabilitySelectionsEquivalentV1({}, { skills: { ...emptySkills, forceIncludeSkillIds: ['lint'] } })).toBe(false);
    expect(selection.areSessionCapabilitySelectionsEquivalentV1({}, { skills: { ...emptySkills, excludeNativeSkillNames: ['lint'] } })).toBe(false);
  });
  it('ignores order and redundant included exclusions for both kinds without folding native name case', () => {
    const left = {
      mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['a', 'b'], forceExcludeServerIds: ['b'] },
      skills: { v: 1 as const, forceIncludeSkillIds: ['lint', 'review'], forceExcludeSkillIds: ['review'], excludeNativeSkillNames: ['Native', 'lint'] },
    };
    const right = {
      mcp: { ...left.mcp, forceIncludeServerIds: ['a'] },
      skills: { ...left.skills, forceIncludeSkillIds: ['lint'], excludeNativeSkillNames: ['lint', 'Native'] },
    };
    expect(selection.areSessionCapabilitySelectionsEquivalentV1(left, right)).toBe(true);
    expect(selection.areSessionCapabilitySelectionsEquivalentV1(left, { ...right,
      skills: { ...right.skills, excludeNativeSkillNames: ['lint', 'native'] },
    })).toBe(false);
  });
});
