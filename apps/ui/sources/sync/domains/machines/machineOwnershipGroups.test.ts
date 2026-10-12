import { describe, expect, it } from 'vitest';

import { describeMachineSharedOwnership } from './machineOwnershipGroups';

const shared = (displayName: string | null) =>
  ({
    isShared: true,
    access: { custodian: { accountId: 'owner', displayName } },
    metadata: { platform: 'linux' },
  }) as unknown as Parameters<typeof describeMachineSharedOwnership>[0];

describe('describeMachineSharedOwnership', () => {
  it('names the owner of a shared machine beside its platform', () => {
    expect(describeMachineSharedOwnership(shared('Ana Ruiz'))).toBe(
      "Ana Ruiz's · Linux",
    );
  });

  it('says only the platform when the owner has no public name, never a bare possessive', () => {
    for (const name of ['', '   ', null]) {
      expect(describeMachineSharedOwnership(shared(name))).toBe('Linux');
    }
  });
});
