import type { FeedItem } from '../../domains/social/feedTypes';
import { loadSyncTuning } from '../../runtime/syncTuning';
import type { StoreGet, StoreSet } from './_shared';
import { areAccountSettingsJsonValuesEqual } from '../../domains/settings/accountSettingsStructuralEquality';

const FEED_ITEMS_MAX_ENTRIES = loadSyncTuning().feedItemsMaxEntries;

export type FeedDomain = {
  feedItems: FeedItem[];
  feedHead: string | null;
  feedTail: string | null;
  feedHasMore: boolean;
  feedLoaded: boolean;
  applyFeedItems: (items: FeedItem[]) => void;
  clearFeed: () => void;
};

export function createFeedDomain<S extends FeedDomain & { friendsLoaded: boolean }>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): FeedDomain {
  return {
    feedItems: [],
    feedHead: null,
    feedTail: null,
    feedHasMore: false,
    feedLoaded: false,
    applyFeedItems: (items) =>
      set((state) => {
        // Always mark feed as loaded even if empty
        if (items.length === 0) {
          return state.feedLoaded ? state : { ...state, feedLoaded: true };
        }

        // Create a map of existing items for quick lookup
        const existingMap = new Map<string, FeedItem>();
        const idByRepeatKey = new Map<string, string>();
        state.feedItems.forEach((item) => {
          existingMap.set(item.id, item);
          if (item.repeatKey) idByRepeatKey.set(item.repeatKey, item.id);
        });

        // Process new items
        let changed = false;
        let head = state.feedHead;
        let tail = state.feedTail;

        items.forEach((newItem) => {
          // An echo of the same row is not a repeat-key replacement.
          if (newItem.repeatKey) {
            const repeatedId = idByRepeatKey.get(newItem.repeatKey);
            if (repeatedId && repeatedId !== newItem.id) {
              existingMap.delete(repeatedId);
              changed = true;
            }
          }

          const previous = existingMap.get(newItem.id);
          if (!areAccountSettingsJsonValuesEqual(previous, newItem)) {
            if (previous?.repeatKey) idByRepeatKey.delete(previous.repeatKey);
            existingMap.set(newItem.id, previous && areAccountSettingsJsonValuesEqual(previous.body, newItem.body)
              ? { ...newItem, body: previous.body }
              : newItem);
            changed = true;
          }
          if (newItem.repeatKey) idByRepeatKey.set(newItem.repeatKey, newItem.id);

          // Update head/tail cursors
          if (!head || newItem.counter > parseInt(head.substring(2), 10)) {
            head = newItem.cursor;
          }
          if (!tail || newItem.counter < parseInt(tail.substring(2), 10)) {
            tail = newItem.cursor;
          }
        });

        // Sort by counter (desc - newest first)
        const updatedItems = changed
          ? [...existingMap.values()].sort((a, b) => b.counter - a.counter).slice(0, FEED_ITEMS_MAX_ENTRIES)
          : state.feedItems;
        const retainedItems = updatedItems.length === state.feedItems.length
          && updatedItems.every((item, index) => item === state.feedItems[index])
          ? state.feedItems
          : updatedItems;
        tail = retainedItems.length > 0
          ? retainedItems[retainedItems.length - 1]!.cursor
          : null;

        if (retainedItems === state.feedItems && head === state.feedHead && tail === state.feedTail && state.feedLoaded) {
          return state;
        }

        return {
          ...state,
          feedItems: retainedItems,
          feedHead: head,
          feedTail: tail,
          feedLoaded: true, // Mark as loaded after first fetch
        };
      }),
    clearFeed: () =>
      set((state) => {
        if (state.feedItems.length === 0 && state.feedHead === null && state.feedTail === null
          && !state.feedHasMore && !state.feedLoaded && !state.friendsLoaded) return state;
        return {
          ...state,
          feedItems: [],
          feedHead: null,
          feedTail: null,
          feedHasMore: false,
          feedLoaded: false, // Reset loading flag
          friendsLoaded: false, // Reset loading flag
        };
      }),
  };
}
