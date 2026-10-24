import { describe, expect, it } from 'vitest';

import { ChangeKindSchema } from './index.js';

describe('Machine recipient access AccountChange kind', () => {
  it('admits the recipient-specific Machine change fact', () => {
    expect(ChangeKindSchema.parse('machineRecipientAccess')).toBe('machineRecipientAccess');
  });
});
