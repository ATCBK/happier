import { describe, expect, it } from 'vitest';

import { estimateTokensV1 } from './estimateTokensV1.js';

describe('estimateTokensV1', () => {
  it('rounds partial groups of four characters up and keeps empty text free', () => {
    expect([0, 1, 4, 5].map(length => estimateTokensV1('x'.repeat(length)))).toEqual([0, 1, 1, 2]);
  });
});
