import { describe, expect, it } from 'vitest';
import { createRowInventoryReceiptOrdering } from './rowInventoryReceiptOrdering';

describe('row inventory receipt ordering', () => {
    it('keeps receipt history separate from equal and recreated read admission, scoped to the Account', () => {
        const ordering = createRowInventoryReceiptOrdering();
        const scope = { serverId: 'home', accountId: 'owner' };
        expect(ordering.admitRead(scope, 'row', 10)).toBe(true);
        expect(ordering.admitRead(scope, 'row', 10, 10)).toBe(true);
        expect(ordering.admitRead(scope, 'row', 9, 10)).toBe(false);
        expect(ordering.admitRemoval(scope, 'row', 9)).toBe(false);
        expect(ordering.admitRemoval(scope, 'row', 11)).toBe(true);
        expect(ordering.admitRead(scope, 'row', 1)).toBe(true);
        expect(ordering.admit(scope, 'row', 11)).toBe(false);
        expect(ordering.admit({ ...scope, accountId: 'other' }, 'row', 1)).toBe(true);
        ordering.clearScope(scope);
        expect(ordering.admit(scope, 'row', 1)).toBe(true);
        expect(ordering.admit(scope, 'row', 1)).toBe(false);
        expect(ordering.admit(scope, 'row', 2)).toBe(true);
    });
});
