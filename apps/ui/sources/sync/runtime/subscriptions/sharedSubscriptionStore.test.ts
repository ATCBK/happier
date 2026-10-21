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
    it.each(['settled', 'in-flight'] as const)('recovers a failed initial snapshot on the existing recovery signal (%s)', async phase => {
        let recover: (() => void) | undefined;
        let finishInitial!: (value: number) => void;
        let available = false;
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => available ? 1 : await new Promise<number>(resolve => { finishInitial = resolve; }),
            defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            shouldWatch: state => state > 0,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return () => {}; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        try {
            expect(replies).toHaveLength(0);
            if (phase === 'in-flight') {
                available = true;
                recover?.();
                finishInitial(-1);
            } else {
                finishInitial(-1);
                await vi.waitFor(() => expect(store.getState('machine')).toBe(-1));
                available = true;
                recover?.();
            }
            await vi.waitFor(() => expect(store.getState('machine')).toBe(1));
            expect(replies).toHaveLength(1);
            replies[0]!({ status: 'changed', snapshot: 2 });
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
        } finally { release(); store.reset(); }
    });

    it('recovers retired observation only on a demanded recovery event and releases its listener', async () => {
        let recover: (() => void) | undefined;
        const detach = vi.fn();
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        let reads = 0;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => ++reads, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return detach; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        const releaseSibling = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        store.publish('machine', 9);
        expect(detach).not.toHaveBeenCalled();
        recover?.();
        expect(reads).toBe(1);
        replies[0]!({ status: 'idle' });
        await vi.waitFor(() => expect(replies).toHaveLength(2));
        replies[1]!({ status: 'unavailable' });
        await Promise.resolve();
        await Promise.resolve();
        expect(replies).toHaveLength(2);
        recover?.();
        await vi.waitFor(() => expect(replies).toHaveLength(3));
        expect(store.getState('machine')).toBe(2);
        release();
        expect(detach).not.toHaveBeenCalled();
        releaseSibling();
        expect(detach).toHaveBeenCalledOnce();
        recover?.();
        expect(reads).toBe(2);
        store.reset();
    });

    it('keeps a recovery wake when the old watch subsequently makes the retained state unwatchable', async () => {
        let recover: (() => void) | undefined;
        let value = 1;
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => value, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            shouldWatch: state => state > 0,
            subscribeRecovery: (_input: string, listener: () => void) => { recover = listener; return () => {}; },
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const release = store.subscribe('machine', () => {});
        try {
            await vi.waitFor(() => expect(replies).toHaveLength(1));
            value = 2;
            recover?.();
            replies[0]!({ status: 'changed', snapshot: -1 });
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
            expect(replies).toHaveLength(2);
        } finally { release(); store.reset(); }
    });

    it('rearms a retired watch when a retained entry gains demand again', async () => {
        let reads = 0;
        const watches: Array<AbortSignal | undefined> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => ++reads, defaultWatchClient: {}, watchAfterRefresh: true, retainState: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: async ({ signal }) => {
                watches.push(signal);
                return watches.length === 1 ? { status: 'unavailable' as const }
                    : new Promise<SharedSubscriptionWatchOutcome<number>>(() => {});
            },
        });
        const release = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        release();
        const resumed = store.subscribe('machine', () => {});
        try {
            await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
            expect(watches).toHaveLength(2);
            expect(watches[1]?.aborted).toBe(false);
        } finally { resumed(); store.reset(); }
    });

    it('reads again when invalidation lands during a read, retaining the last snapshot until the follow-up settles', async () => {
        const reads: Array<(value: number) => void> = [];
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: () => new Promise<number>(resolve => reads.push(resolve)),
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
        });
        const unsubscribe = store.subscribe('machine', () => {});
        store.invalidate('machine');
        store.invalidate('machine');
        reads[0]!(1);
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(store.getState('machine')).toBe(1);
        reads[1]!(2);
        await vi.waitFor(() => expect(store.getState('machine')).toBe(2));
        unsubscribe();
    });

    it('keeps watching when an invalidation overtakes an unavailable watch reply', async () => {
        const replies: Array<(value: SharedSubscriptionWatchOutcome<number>) => void> = [];
        let value = 1;
        const store = createSharedSubscriptionStore({
            emptyState: 0, createState: () => 0, normalizeInput: (key: string) => key, storeKey: (key: string) => key,
            defaultSnapshotClient: async () => value, defaultWatchClient: {}, watchAfterRefresh: true,
            refresh: ({ snapshotClient }) => snapshotClient(), applySnapshot: (_state: number, snapshot: number) => snapshot,
            watch: () => new Promise<SharedSubscriptionWatchOutcome<number>>(resolve => replies.push(resolve)),
        });
        const unsubscribe = store.subscribe('machine', () => {});
        await vi.waitFor(() => expect(replies).toHaveLength(1));
        value = 2;
        store.invalidate('machine');
        replies[0]!({ status: 'unavailable' });
        await vi.waitFor(() => expect(replies).toHaveLength(2));
        expect(store.getState('machine')).toBe(2);
        unsubscribe();
    });
    it.each(['unavailable', 'rejection', 'changed', 'idle', 'retry'] as const)('restores publication freshness while an old watch finishes with %s', async outcome => {
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
