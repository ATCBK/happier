import { afterEach, describe, expect, it, vi } from 'vitest';

import { publishMountedDiscussionChanges, watchMountedDiscussions } from './discussionChangeWatch';

afterEach(() => {
    vi.clearAllMocks();
});

describe('mounted Discussion AccountChange watch', () => {
    it('invalidates Home Discussions without any Session change and isolates the captured Account', () => {
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({
            address: { serverId: 'server-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' },
            onInvalidated,
        });
        publishMountedDiscussionChanges({
            serverId: 'server-a', accountId: 'account-b',
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }],
        });
        expect(onInvalidated).not.toHaveBeenCalled();
        publishMountedDiscussionChanges({
            serverId: 'server-a', accountId: 'account-a',
            changes: [{ cursor: 2, kind: 'discussion', entityId: 'discussion-a', changedAt: 2 }],
        });
        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(onInvalidated).toHaveBeenLastCalledWith(['discussion-a'], new Map([['discussion-a', 2]]));
        watch.dispose();
    });

    it('wakes only the captured Home and Account for coalesced Discussion changes', async () => {
        const onFirstInvalidated = vi.fn();
        const onSecondHomeInvalidated = vi.fn();
        const onSecondSessionInvalidated = vi.fn();

        const first = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            address: { serverId: 'server-a' },
            onInvalidated: onFirstInvalidated,
        });
        const secondHome = watchMountedDiscussions({
            scope: { serverId: 'server-b', accountId: 'account-a' },
            address: { serverId: 'server-b' },
            onInvalidated: onSecondHomeInvalidated,
        });
        const secondSession = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-b' },
            address: { serverId: 'server-a' },
            onInvalidated: onSecondSessionInvalidated,
        });

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{
                cursor: 1,
                kind: 'discussion',
                entityId: 'same-session',
                changedAt: 1,
                hint: { unrelatedSessionProjection: true },
            }],
        });

        expect(onFirstInvalidated).toHaveBeenCalledOnce();
        expect(onSecondHomeInvalidated).not.toHaveBeenCalled();
        expect(onSecondSessionInvalidated).not.toHaveBeenCalled();

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{
                cursor: 2,
                kind: 'discussion',
                entityId: 'same-session',
                changedAt: 2,
                hint: { v: 1, discussions: true },
            }],
        });
        expect(onFirstInvalidated).toHaveBeenCalledTimes(2);

        first.dispose();
        secondHome.dispose();
        secondSession.dispose();
        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{ cursor: 3, kind: 'discussion', entityId: 'same-session', changedAt: 3 }],
        });
        expect(onFirstInvalidated).toHaveBeenCalledTimes(2);
    });

    it('ignores unrelated changes even when their entity id matches a Discussion', async () => {
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            address: { serverId: 'server-a' },
            onInvalidated,
        });

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [
                { cursor: 1, kind: 'share', entityId: 'same-session', changedAt: 1 },
                { cursor: 2, kind: 'account', entityId: 'same-session', changedAt: 2 },
            ],
        });

        expect(onInvalidated).not.toHaveBeenCalled();
        watch.dispose();
    });
});
