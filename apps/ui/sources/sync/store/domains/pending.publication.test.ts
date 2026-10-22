import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createPendingDomain, type PendingDomain } from './pending';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

const pending = (id: string, text = id): PendingMessage => ({ id, localId: id, text, createdAt: 1, updatedAt: 1,
    rawRecord: { role: 'user', content: { type: 'text', text } } });

describe('pending publication', () => {
    it('keeps equal snapshots quiet and retains unchanged rows when a sibling changes', () => {
        const store = createStore<PendingDomain>()((set, get) => createPendingDomain({ set, get }));
        const messages = [pending('p1'), pending('p2')];
        store.getState().applyPendingSnapshot('session', { messages, discarded: [] });
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => notifications++);
        store.getState().applyPendingSnapshot('session', { messages: structuredClone(messages), discarded: [] });
        store.getState().upsertPendingMessage('session', structuredClone(messages[0]!));
        expect(store.getState()).toBe(before);
        expect(notifications).toBe(0);
        store.getState().applyPendingSnapshot('session', { messages: [pending('p1'), pending('p2', 'Changed')], discarded: [] });
        expect(store.getState().sessionPending.session?.messages[0]).toBe(before.sessionPending.session?.messages[0]);
        expect(store.getState().sessionPending.session?.discarded).toBe(before.sessionPending.session?.discarded);
        expect(store.getState().sessionPending.session?.messages[1]?.text).toBe('Changed');
        expect(notifications).toBe(1);
        unsubscribe();
    });
});
