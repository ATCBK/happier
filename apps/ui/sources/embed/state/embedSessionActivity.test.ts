import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const kvStore = vi.hoisted(() => new Map<string, string>());
// MMKV is the persistence boundary under the real session store.
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) { return kvStore.get(key); }
        set(key: string, value: string) { kvStore.set(key, value); }
        delete(key: string) { kvStore.delete(key); }
        clearAll() { kvStore.clear(); }
    }
    return { MMKV };
});

const { storage } = await import('@/sync/domains/state/storage');
const { watchEmbedSessionActivity } = await import('./embedSessionActivity');

const NOW = 1_800_000_000_000;

describe('embed session activity', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
    });

    it('reports idle, working and needs attention from the session awareness owner, once per change', () => {
        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, activeAt: NOW, updatedAt: NOW })]);
        const seen: string[] = [];
        const stop = watchEmbedSessionActivity({ sessionId: 's1', onActivity: (activity) => seen.push(activity), now: () => NOW });

        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, activeAt: NOW, updatedAt: NOW, thinking: true, thinkingAt: NOW })]);
        storage.getState().applySessions([createSessionFixture({ id: 's2', active: true, activeAt: NOW, updatedAt: NOW, thinking: true, thinkingAt: NOW })]);
        storage.getState().applySessions([createSessionFixture({
            id: 's1', active: true, activeAt: NOW, updatedAt: NOW, thinking: true, thinkingAt: NOW,
            agentState: { requests: { r1: { tool: 'edit', arguments: {}, createdAt: NOW } } },
        })]);
        stop();
        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, activeAt: NOW, updatedAt: NOW })]);

        expect(seen).toEqual(['idle', 'working', 'needs_attention']);
    });

    it('reports a Session held by a blocking usage limit as needing attention', () => {
        storage.getState().applySessions([createSessionFixture({
            id: 's1', active: true, presence: 'online', activeAt: NOW, updatedAt: NOW,
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: NOW,
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit', occurredAt: NOW },
        })]);
        const seen: string[] = [];
        const stop = watchEmbedSessionActivity({ sessionId: 's1', onActivity: (activity) => seen.push(activity), now: () => NOW + 1 });
        stop();

        expect(seen).toEqual(['needs_attention']);
    });
});
