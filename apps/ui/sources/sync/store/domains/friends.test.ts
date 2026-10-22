import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { UserProfile } from '@/sync/domains/social/friendTypes';

import { createFriendsDomain, type FriendsDomain } from './friends';

type FriendsTestState = FriendsDomain & { profile: { id: string } };

const assumeUsersMock = vi.hoisted(() => vi.fn());
const legacyAssumeUsersMock = vi.hoisted(() => vi.fn());
const getSyncSingletonMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: getSyncSingletonMock,
}));

vi.mock('../../sync', () => ({
    sync: {
        assumeUsers: legacyAssumeUsersMock,
    },
}));

function createTestStore() {
    return createStore<FriendsTestState>((set, get) => ({
        profile: { id: 'me' },
        ...createFriendsDomain<FriendsTestState>({ get, set }),
    }));
}

function user(id: string): UserProfile {
    return { id, name: id, firstName: id, lastName: null, username: id, bio: null,
        avatar: null, badges: [], status: 'friend', publicKey: null };
}

describe('createFriendsDomain', () => {
    beforeEach(() => {
        assumeUsersMock.mockReset();
        legacyAssumeUsersMock.mockReset();
        getSyncSingletonMock.mockReset();
        getSyncSingletonMock.mockReturnValue({
            assumeUsers: assumeUsersMock,
        });
        assumeUsersMock.mockResolvedValue(undefined);
        legacyAssumeUsersMock.mockResolvedValue(undefined);
    });

    it('delegates assumeUsers through the runtime sync singleton', async () => {
        const domain = createTestStore().getState();

        await domain.assumeUsers(['user-1', 'user-2']);

        expect(getSyncSingletonMock).toHaveBeenCalledTimes(1);
        expect(assumeUsersMock).toHaveBeenCalledWith(['user-1', 'user-2']);
        expect(legacyAssumeUsersMock).not.toHaveBeenCalled();
    });

    it('publishes the first empty friends load once', () => {
        const api = createTestStore();
        const notified = vi.fn();
        api.subscribe(notified);
        api.getState().applyFriends([]);
        const loaded = api.getState();
        api.getState().applyFriends([]);
        expect(loaded.friendsLoaded).toBe(true);
        expect(api.getState()).toBe(loaded);
        expect(notified).toHaveBeenCalledTimes(1);
    });

    it('keeps equal friends and user records and publishes changed content immediately', () => {
        const api = createTestStore();
        api.getState().applyFriends([user('a'), user('b')]);
        api.getState().applyUsers({ a: user('a'), absent: null });
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);

        api.getState().applyFriends([user('a'), user('b')]);
        api.getState().applyUsers({ a: user('a'), absent: null });
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.getState().applyFriends([{ ...user('a'), name: 'Changed' }, user('b')]);
        expect(api.getState().friends.a?.name).toBe('Changed');
        expect(api.getState().friends.a?.badges).toBe(previous.friends.a?.badges);
        expect(api.getState().friends.b).toBe(previous.friends.b);
        expect(api.getState().users).toBe(previous.users);
        api.getState().applyUsers({ a: { ...user('a'), publicKey: 'new-key' } });
        expect(api.getState().users.a?.publicKey).toBe('new-key');
        expect(api.getState().users.a?.badges).toBe(previous.users.a?.badges);
        expect(notified).toHaveBeenCalledTimes(2);
    });

    it('suppresses redundant relationship events but keeps creation, updates and removal fresh', () => {
        const api = createTestStore();
        const event = { fromUserId: 'me', toUserId: 'a', status: 'friend', action: 'updated', timestamp: 1 } as const;
        api.getState().applyFriends([user('a')]);
        const previous = api.getState();
        const notified = vi.fn();
        api.subscribe(notified);
        api.getState().applyRelationshipUpdate({ ...event, toUser: user('a') });
        api.getState().applyRelationshipUpdate({ ...event, toUserId: 'absent', action: 'deleted' });
        api.getState().applyRelationshipUpdate(event);
        expect(api.getState()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.getState().applyRelationshipUpdate({ ...event, toUser: { ...user('a'), status: 'pending' }, status: 'pending' });
        expect(api.getState().friends.a?.status).toBe('pending');
        expect(api.getState().friends.a?.badges).toBe(previous.friends.a?.badges);
        api.getState().applyRelationshipUpdate({ ...event, action: 'deleted' });
        expect(api.getState().friends.a).toBeUndefined();
        api.getState().applyRelationshipUpdate({ ...event, action: 'created', toUser: user('a') });
        expect(api.getState().friends.a?.status).toBe('friend');
        expect(notified).toHaveBeenCalledTimes(3);
    });
});
