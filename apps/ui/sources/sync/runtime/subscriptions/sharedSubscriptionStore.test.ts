import { describe, expect, it, vi } from 'vitest';

import { createSharedSubscriptionStore, type SharedSubscriptionWatchOutcome } from './sharedSubscriptionStore';

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
    it.each(['unavailable', 'rejection', 'changed', 'idle'] as const)('restores publication freshness while an old watch finishes with %s', async outcome => {
        const pending: Array<{ signal?: AbortSignal; resolve(value: SharedSubscriptionWatchOutcome<number>): void; reject(error: unknown): void }> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (input: string) => input, storeKey: (input: string) => input,
            defaultSnapshotClient: async () => 1, defaultWatchClient: {}, watchAfterRefresh: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            // The parked network reply is the boundary; store lifecycle remains real.
            watch: ({ signal }) => new Promise<SharedSubscriptionWatchOutcome<number>>((resolve, reject) => pending.push({ signal, resolve, reject })),
        });
        const unsubscribe = store.subscribe('a', () => {});
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        store.publish('a', 2);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.signal?.aborted).toBe(false);
        if (outcome === 'rejection') pending[0]!.reject(new Error('offline'));
        else pending[0]!.resolve(outcome === 'changed' ? { status: 'changed', snapshot: 3 } : { status: outcome });
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        expect(store.getState('a')).toBe(outcome === 'changed' ? 3 : 2);
        pending[1]!.resolve({ status: 'changed', snapshot: 4 });
        await vi.waitFor(() => expect(store.getState('a')).toBe(4));
        unsubscribe();
        expect(pending.at(-1)?.signal?.aborted).toBe(true);
        store.reset();
    });

    it('restores an already retired watch on publication and ignores late answers after disposal', async () => {
        let calls = 0;
        let finish!: (value: SharedSubscriptionWatchOutcome<number>) => void;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (input: string) => input, storeKey: (input: string) => input,
            defaultSnapshotClient: async () => 1, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async () => ++calls === 1 ? { status: 'unavailable' as const }
                : new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => { finish = resolve; }),
        });
        const unsubscribe = store.subscribe('a', () => {});
        await vi.waitFor(() => expect(calls).toBe(1));
        store.publish('a', 2);
        await vi.waitFor(() => expect(calls).toBe(2));
        unsubscribe();
        finish({ status: 'changed', snapshot: 0 });
        await Promise.resolve();
        expect(store.getState('a')).toBe(2);
        expect(calls).toBe(2);
        store.reset();
    });
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
