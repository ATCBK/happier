import { describe, expect, it } from 'vitest';

import { isPersistentMachine, type MachineKind } from './machineKind.js';

describe('isPersistentMachine', () => {
    it('treats released projections without a discriminator as persistent', () => {
        expect(isPersistentMachine({})).toBe(true);
        expect(isPersistentMachine({ kind: 'persistent' })).toBe(true);
        expect(isPersistentMachine({ kind: 'ephemeral_session_runner' })).toBe(false);
    });

    it('excludes a kind this reader does not know instead of throwing inside selection', () => {
        expect(isPersistentMachine({ kind: 'future_kind' as MachineKind })).toBe(false);
    });
});
