import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import type { FeedItem } from '@/sync/domains/social/feedTypes';

import { createFeedDomain } from './feed';

type State = ReturnType<typeof createFeedDomain> & { friendsLoaded: boolean };

function createHarness() {
    const api = createStore<State>((set, get) => ({
        friendsLoaded: true,
        ...createFeedDomain<State>({ get, set }),
    }));
    return { ...api, get: api.getState };
}

function feedItem(id: number): FeedItem {
    return {
        id: `feed-${id}`,
        cursor: `fc${id}`,
        counter: id,
        createdAt: id,
        repeatKey: null,
        body: { kind: 'text', text: `Item ${id}` },
    };
}

describe('createFeedDomain retention', () => {
    it('retains only the bounded newest feed items', () => {
        const api = createHarness();
        const { get } = api;
        const max = loadSyncTuning().feedItemsMaxEntries;

        get().applyFeedItems(Array.from({ length: max + 5 }, (_, index) => feedItem(index + 1)));

        expect(get().feedItems).toHaveLength(max);
        expect(get().feedItems[0]?.id).toBe(`feed-${max + 5}`);
        expect(get().feedItems.at(-1)?.id).toBe('feed-6');
        expect(get().feedTail).toBe('fc6');

        const previous = get();
        const notified = vi.fn();
        api.subscribe(notified);
        get().applyFeedItems(Array.from({ length: max + 5 }, (_, index) => feedItem(index + 1)));
        expect(get()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();
    });

    it('suppresses repeated empty loads and clears', () => {
        const api = createHarness();
        const notified = vi.fn();
        api.subscribe(notified);
        api.get().applyFeedItems([]);
        const loaded = api.get();
        api.get().applyFeedItems([]);
        expect(api.get()).toBe(loaded);
        api.get().clearFeed();
        const cleared = api.get();
        api.get().clearFeed();
        expect(api.get()).toBe(cleared);
        expect(notified).toHaveBeenCalledTimes(2);
    });

    it('retains equal feed rows on replay, including repeat keys, and applies changed content', () => {
        const api = createHarness();
        const first = { ...feedItem(1), repeatKey: 'relationship-a' };
        api.get().applyFeedItems([first, feedItem(2), structuredClone(first)]);
        const previous = api.get();
        const notified = vi.fn();
        api.subscribe(notified);

        api.get().applyFeedItems([structuredClone(first), feedItem(2)]);
        expect(api.get()).toBe(previous);
        expect(notified).not.toHaveBeenCalled();

        api.get().applyFeedItems([{ ...feedItem(2), createdAt: 3 }]);
        expect(api.get().feedItems[0]?.createdAt).toBe(3);
        expect(api.get().feedItems[0]?.body).toBe(previous.feedItems[0]?.body);
        expect(api.get().feedItems[1]).toBe(previous.feedItems[1]);
        expect(notified).toHaveBeenCalledTimes(1);

        api.get().applyFeedItems([{ ...feedItem(3), repeatKey: 'relationship-a' }]);
        expect(api.get().feedItems.map((item) => item.id)).toEqual(['feed-3', 'feed-2']);
        expect(api.get().feedHead).toBe('fc3');
        expect(api.get().feedTail).toBe('fc2');
    });
});
