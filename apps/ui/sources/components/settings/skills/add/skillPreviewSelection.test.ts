import { describe, expect, it } from 'vitest';

import { tickAllSkillPreviews, toggleSkillPreview } from './skillPreviewSelection';

const items = [
  { path: 'a', siblingSkills: [{ path: 'b', references: ['../b/SKILL.md'] }] },
  { path: 'b' },
  { path: 'c' },
];

describe('skill preview selection', () => {
  it('starts with everything previewed ticked', () => {
    expect([...tickAllSkillPreviews(items)]).toEqual(['a', 'b', 'c']);
  });

  it('ticks the siblings a skill refers to along with it, and unticks only what was pressed', () => {
    const off = toggleSkillPreview(items, tickAllSkillPreviews(items), 'b');
    expect([...off].sort()).toEqual(['a', 'c']);
    const withoutA = toggleSkillPreview(items, off, 'a');
    expect([...withoutA]).toEqual(['c']);
    expect([...toggleSkillPreview(items, withoutA, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves a skill alone that refers to nothing listed', () => {
    expect([...toggleSkillPreview(items, new Set(), 'c')]).toEqual(['c']);
  });
});
