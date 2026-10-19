import { describe, expect, it } from 'vitest';
import { advanceResolvedInboxItem, moveInboxItem } from './inboxItemNavigation';
import type { InboxItem } from './inboxItems';

const rows = ['first', 'selected', 'next'].map(id => ({ key: id, view: 'needs_you',
    focus: { kind: 'session', id, serverId: 'home-a' },
} satisfies Pick<InboxItem, 'key' | 'view' | 'focus'>));

describe('Inbox item navigation', () => {
    it('moves in visible order and stops at the list boundaries', () => {
        expect(moveInboxItem(rows, null, 1)).toBe(rows[0]);
        expect(moveInboxItem(rows, null, -1)).toBe(rows[2]);
        expect(moveInboxItem(rows, 'selected', 1)).toBe(rows[2]);
        expect(moveInboxItem(rows, 'selected', -1)).toBe(rows[0]);
        expect(moveInboxItem(rows, 'next', 1)).toBe(rows[2]);
        expect(moveInboxItem([], null, 1)).toBeNull();
    });

    it('advances a resolved Needs-you request to the next surviving item, never through Updates or Mentions', () => {
        const current = [rows[0]!, rows[2]!];
        expect(advanceResolvedInboxItem('needs_you', rows, current, 'selected')).toBe(rows[2]);
        expect(advanceResolvedInboxItem('needs_you', rows, [rows[0]!], 'next')).toBe(rows[0]);
        expect(advanceResolvedInboxItem('needs_you', rows, rows, 'selected')).toBeNull();
        expect(advanceResolvedInboxItem('updates', rows, current, 'selected')).toBeNull();
        expect(advanceResolvedInboxItem('mentions', rows, current, 'selected')).toBeNull();
        expect(advanceResolvedInboxItem('needs_you', rows, [], 'selected')).toBeNull();
    });
});
