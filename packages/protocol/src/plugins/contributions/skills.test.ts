import { describe, expect, it } from 'vitest';
import { PluginSkillContributionV1Schema } from './skills.js';

describe('packaged skill declarations', () => {
  it('admits only closed, portable, package-confined directory declarations', () => {
    const declaration = { id: 'check-capabilities', directory: './resources/skills/check-capabilities' };
    expect(PluginSkillContributionV1Schema.parse(declaration)).toEqual(declaration);
    expect(PluginSkillContributionV1Schema.parse({ ...declaration, directory: 'resources/skills/check-capabilities' })).toBeDefined();
    for (const directory of ['', '.', './', '..', '../skill', './a/../../skill', '/skill', 'C:/skill', '\\skill',
      'resources\\skill', 'resources//skill', 'resources/CON', 'resources/skill.', 'resources/skill ']) {
      expect(PluginSkillContributionV1Schema.safeParse({ ...declaration, directory }).success, directory).toBe(false);
    }
    expect(PluginSkillContributionV1Schema.safeParse({ ...declaration, name: 'duplicate metadata' }).success).toBe(false);
  });
});
