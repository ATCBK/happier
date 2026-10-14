import { describe, expect, it } from 'vitest';

import { resolveTimestampedFieldUpdate } from '../timestamps/resolveTimestampedFieldUpdate.js';

describe('resolveTimestampedFieldUpdate', () => {
  it.each(['drop', 'bump-if-value-changed'] as const)('accepts an initial zero timestamp without a stored competitor (%s)', staleBehavior => {
    expect(resolveTimestampedFieldUpdate({ current: null,
      candidate: { value: 'low', updatedAt: 0 }, staleBehavior,
    })).toEqual({ accepted: true, value: 'low', updatedAt: 0, reason: 'newer' });
  });

  it('keeps a stored zero timestamp authoritative against a tied candidate', () => {
    expect(resolveTimestampedFieldUpdate({ current: { value: 'high', updatedAt: 0 },
      candidate: { value: 'low', updatedAt: 0 }, staleBehavior: 'drop',
    })).toEqual({ accepted: false, reason: 'stale' });
  });

  it('drops stale candidates by default', () => {
    expect(resolveTimestampedFieldUpdate({
      current: { value: 'current', updatedAt: 10 },
      candidate: { value: 'candidate', updatedAt: 9 },
      staleBehavior: 'drop',
    })).toEqual({ accepted: false, reason: 'stale' });
  });

  it('accepts newer candidates', () => {
    expect(resolveTimestampedFieldUpdate({
      current: { value: 'current', updatedAt: 10 },
      candidate: { value: 'candidate', updatedAt: 11 },
      staleBehavior: 'drop',
    })).toEqual({
      accepted: true,
      value: 'candidate',
      updatedAt: 11,
      reason: 'newer',
    });
  });

  it('bumps stale explicit local writes when the value changes', () => {
    expect(resolveTimestampedFieldUpdate({
      current: { value: 'current', updatedAt: 10 },
      candidate: { value: 'candidate', updatedAt: 7 },
      staleBehavior: 'bump-if-value-changed',
    })).toEqual({
      accepted: true,
      value: 'candidate',
      updatedAt: 11,
      reason: 'bumped',
    });
  });

  it('does not bump unchanged values', () => {
    expect(resolveTimestampedFieldUpdate({
      current: { value: 'current', updatedAt: 10 },
      candidate: { value: 'current', updatedAt: 7 },
      staleBehavior: 'bump-if-value-changed',
    })).toEqual({ accepted: false, reason: 'unchanged' });
  });
});
