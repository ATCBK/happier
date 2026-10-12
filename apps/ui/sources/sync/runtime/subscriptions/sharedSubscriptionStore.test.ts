import { describe, expect, it, vi } from 'vitest';

import { createSharedSubscriptionStore } from './sharedSubscriptionStore';

type TestInput = Readonly<{
    machineId: string;
    serverId?: string | null;
}>;

type TestState = Readonly<{
    value: number;
    refreshes: number;
}>;

type TestSnapshot = Readonly<{ value: number }>;

describe('createSharedSubscriptionStore', () => {
    it('keeps a retained snapshot after demand ends and shares a one-shot read without opening a watch', async () => {
        const snapshotClient = vi.fn(async () => 7);
        const watchClient = vi.fn(async () => ({ status: 'unavailable' as const }));
        const store = createSharedSubscriptionStore({
            emptyState: 0,
            createState: () => 0,
            normalizeInput: (input: string) => input,
            storeKey: (input: string) => input,
            defaultSnapshotClient: snapshotClient,
            defaultWatchClient: watchClient,
            retainState: true,
            refresh: async ({ snapshotClient: client }) => client(),
            applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async ({ watchClient: client }) => client(),
        });
        const unsubscribe = store.subscribe('machine-a', () => {});
        await store.read('machine-a');
        unsubscribe();
        expect(store.getState('machine-a')).toBe(7);
        snapshotClient.mockClear();
        watchClient.mockClear();
        await Promise.all([store.read('machine-a'), store.read('machine-a')]);
        expect(snapshotClient).toHaveBeenCalledOnce();
        expect(watchClient).not.toHaveBeenCalled();
        expect(store.getState('machine-a')).toBe(7);
    });
    it('centralizes keyed subscribe, refresh, publish, and cleanup behavior', async () => {
        const snapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: { value: 7 } }));
        const store = createSharedSubscriptionStore<
            TestInput,
            TestState,
            TestSnapshot,
            typeof snapshotClient
        >({
            emptyState: { value: 0, refreshes: 0 },
            createState: () => ({ value: 0, refreshes: 0 }),
            normalizeInput: (input) => ({ machineId: input.machineId, serverId: input.serverId ?? null }),
            storeKey: (input) => `${input.serverId ?? ''}::${input.machineId}`,
            defaultSnapshotClient: snapshotClient,
            refresh: async ({ state, snapshotClient: client }) => {
                const result = await client();
                return result.ok
                    ? { value: result.snapshot.value, refreshes: state.refreshes + 1 }
                    : { ...state, refreshes: state.refreshes + 1 };
            },
            applySnapshot: (state, snapshot) => ({ ...state, value: snapshot.value }),
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const listener = vi.fn();

        const unsubscribeA = store.subscribe(key, listener, { snapshotClient });
        const unsubscribeB = store.subscribe(key, () => {}, { snapshotClient });
        await Promise.resolve();
        await Promise.resolve();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(store.getState(key)).toEqual({ value: 7, refreshes: 1 });

        listener.mockClear();
        store.publish(key, { value: 11 });

        expect(listener).toHaveBeenCalledOnce();
        expect(store.getState(key)).toEqual({ value: 11, refreshes: 1 });

        unsubscribeA();
        unsubscribeB();
        expect(store.getState(key)).toEqual({ value: 0, refreshes: 0 });
    });
});
