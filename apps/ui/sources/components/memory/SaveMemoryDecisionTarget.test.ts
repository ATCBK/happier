import { describe, expect, it } from 'vitest';

const { memoryDecisionTargetControl } = await import('./SaveMemoryDecisionTarget');

describe('Save-to chooser control', () => {
  it('shows a few short places as one segmented row', () => {
    expect(memoryDecisionTargetControl(['Only me', 'payments', 'payments team'])).toBe('segmented');
  });

  it('uses the field menu when a place name is too long to sit in a segment', () => {
    expect(memoryDecisionTargetControl(['Only me', 'qa-n3-q2-r3-project-a', 'payments'])).toBe('menu');
  });

  it('uses the field menu for more places than one row holds, and nothing for none', () => {
    expect(memoryDecisionTargetControl(['Only me', 'a', 'b', 'c'])).toBe('menu');
    expect(memoryDecisionTargetControl([])).toBe('none');
  });
});
