import type { RelationshipUpdatedEvent, UserProfile } from '../../domains/social/friendTypes';
import type { StoreGet, StoreSet } from './_shared';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { areAccountSettingsJsonValuesEqual } from '../../domains/settings/accountSettingsStructuralEquality';

function reconcileUserProfile(previous: UserProfile | null | undefined, next: UserProfile | null): UserProfile | null {
  if (areAccountSettingsJsonValuesEqual(previous, next)) return previous ?? null;
  if (!previous || !next) return next;
  return {
    ...next,
    avatar: areAccountSettingsJsonValuesEqual(previous.avatar, next.avatar) ? previous.avatar : next.avatar,
    badges: areAccountSettingsJsonValuesEqual(previous.badges, next.badges) ? previous.badges : next.badges,
  };
}

export type FriendsDomain = {
  friends: Record<string, UserProfile>;
  users: Record<string, UserProfile | null>;
  friendsLoaded: boolean;
  applyFriends: (friends: UserProfile[]) => void;
  applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
  getFriend: (userId: string) => UserProfile | undefined;
  getAcceptedFriends: () => UserProfile[];
  applyUsers: (users: Record<string, UserProfile | null>) => void;
  getUser: (userId: string) => UserProfile | null | undefined;
  assumeUsers: (userIds: string[]) => Promise<void>;
};

export function createFriendsDomain<
  S extends FriendsDomain & { profile: { id: string } },
>({ set, get }: { set: StoreSet<S>; get: StoreGet<S> }): FriendsDomain {
  return {
    friends: {},
    users: {},
    friendsLoaded: false,
    applyFriends: (friends) =>
      set((state) => {
        let mergedFriends = state.friends;
        friends.forEach((friend) => {
          const previous = mergedFriends[friend.id];
          const next = reconcileUserProfile(previous, friend);
          if (previous === next) return;
          if (mergedFriends === state.friends) mergedFriends = { ...state.friends };
          mergedFriends[friend.id] = next!;
        });
        if (mergedFriends === state.friends && state.friendsLoaded) return state;
        return {
          ...state,
          friends: mergedFriends,
          friendsLoaded: true, // Mark as loaded after first fetch
        };
      }),
    applyRelationshipUpdate: (event) =>
      set((state) => {
        const { fromUserId, toUserId, status, action, fromUser, toUser } = event;
        const currentUserId = state.profile.id;

        // Update friends cache
        // Determine which user profile to update based on perspective
        const otherUserId = fromUserId === currentUserId ? toUserId : fromUserId;
        const otherUser = fromUserId === currentUserId ? toUser : fromUser;

        if (action === 'deleted' || status === 'none') {
          if (!Object.prototype.hasOwnProperty.call(state.friends, otherUserId)) return state;
          // Remove from friends if deleted or status is none
          const updatedFriends = { ...state.friends };
          delete updatedFriends[otherUserId];
          return { ...state, friends: updatedFriends };
        }
        if (!otherUser) return state;
        const next = reconcileUserProfile(state.friends[otherUserId], otherUser);
        if (next === state.friends[otherUserId]) return state;
        return {
          ...state,
          friends: { ...state.friends, [otherUserId]: next! },
        };
      }),
    getFriend: (userId) => get().friends[userId],
    getAcceptedFriends: () => {
      const friends = get().friends;
      return Object.values(friends).filter((friend) => friend.status === 'friend');
    },
    applyUsers: (users) =>
      set((state) => {
        let mergedUsers = state.users;
        for (const [id, user] of Object.entries(users)) {
          const next = reconcileUserProfile(mergedUsers[id], user);
          if (mergedUsers[id] === next) continue;
          if (mergedUsers === state.users) mergedUsers = { ...state.users };
          mergedUsers[id] = next;
        }
        return mergedUsers === state.users ? state : { ...state, users: mergedUsers };
      }),
    getUser: (userId) => get().users[userId], // Returns UserProfile | null | undefined
    assumeUsers: async (userIds) => {
      return getSyncSingleton().assumeUsers(userIds);
    },
  };
}
