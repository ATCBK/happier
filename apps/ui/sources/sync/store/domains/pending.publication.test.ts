import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createPendingDomain, type PendingDomain } from './pending';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';

const pending = (id: string, text = id): PendingMessage => ({ id, localId: id, text, createdAt: 1, updatedAt: 1,
    rawRecord: { role: 'user', content: { type: 'text', text } } });

describe('pending publication', () => {
    it('keeps equal snapshots quiet and retains unchanged rows when a sibling changes', () => {
        const store = createStore<PendingDomain>()((set, get) => createPendingDomain({ set, get }));
        const messages = [pending('p1'), pending('p2')];
        store.getState().applyPendingSnapshot('session', { messages, discarded: [] });
        const before = store.getState();
        const notifications = countStoreNotifications(store);
        store.getState().applyPendingSnapshot('session', { messages: structuredClone(messages), discarded: [] });
        store.getState().upsertPendingMessage('session', structuredClone(messages[0]!));
        expect(store.getState()).toBe(before);
        // Equal writes have no deterministic noise allowance: even an empty
        // Zustand partial would be a root notification despite stable slices.
        expect(notifications.read()).toEqual([]);
        store.getState().applyPendingSnapshot('session', { messages: [pending('p1'), pending('p2', 'Changed')], discarded: [] });
        expect(store.getState().sessionPending.session?.messages[0]).toBe(before.sessionPending.session?.messages[0]);
        expect(store.getState().sessionPending.session?.discarded).toBe(before.sessionPending.session?.discarded);
        expect(store.getState().sessionPending.session?.messages[1]?.text).toBe('Changed');
        expect(notifications.read()).toEqual([['sessionPending']]);
        notifications.stop();
    });
});
