import { create } from 'zustand';
import { expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { createSyncPerformanceTelemetry, installSyncPerformanceTelemetryGlobal } from '../runtime/syncPerformanceTelemetry';
import { observeStoragePerformance } from './storagePerformance';

it('reports actual changed root keys only to opt-in diagnostic listeners, including timing mode and cleanup', () => {
    const target = globalThis as typeof globalThis & {
        __HAPPIER_PERF_DIAGNOSTICS__?: boolean;
        __HAPPIER_SYNC_PERFORMANCE__?: Pick<typeof telemetry, 'subscribeStoreNotifications' | 'storeNotificationsAvailable'>;
    };
    const previous = target.__HAPPIER_PERF_DIAGNOSTICS__;
    const previousApi = target.__HAPPIER_SYNC_PERFORMANCE__;
    const telemetry = createSyncPerformanceTelemetry({ enabled: false, now: () => 17 });
    installSyncPerformanceTelemetryGlobal(telemetry);
    const api = target.__HAPPIER_SYNC_PERFORMANCE__!;
    expect(api.storeNotificationsAvailable()).toBe(false);
    const original = create(() => ({ selected: 0, other: { secret: 'never exported' } }));
    const store = observeStoragePerformance(original, telemetry);
    expect(api.storeNotificationsAvailable()).toBe(true);
    const notifications: unknown[] = [];
    try {
        const ignored = api.subscribeStoreNotifications(event => notifications.push(event));
        original.setState({ selected: 1 });
        expect(notifications).toEqual([]);
        ignored();
        target.__HAPPIER_PERF_DIAGNOSTICS__ = true;
        const unsubscribe = api.subscribeStoreNotifications(event => notifications.push(event));
        store.setState(state => state);
        store.setState({ selected: 1 }); // Real root notification, even though all field references are equal.
        store.setState({ selected: 2 });
        original.setState(state => ({ other: { ...state.other } }));
        expect(notifications).toEqual([
            { atMs: 17, changedKeys: [] },
            { atMs: 17, changedKeys: ['selected'] },
            { atMs: 17, changedKeys: ['other'] },
        ]);
        unsubscribe();
        original.setState({ selected: 3 });
        expect(notifications).toHaveLength(3);
        expect(telemetry.snapshot().events).toEqual([]);
    } finally {
        if (previous === undefined) delete target.__HAPPIER_PERF_DIAGNOSTICS__; else target.__HAPPIER_PERF_DIAGNOSTICS__ = previous;
        if (previousApi === undefined) delete target.__HAPPIER_SYNC_PERFORMANCE__; else target.__HAPPIER_SYNC_PERFORMANCE__ = previousApi;
    }
});

it('attributes real store notifications and selector evaluation without changing selected-result render suppression', async () => {
    const telemetry = createSyncPerformanceTelemetry({ enabled: true });
    const original = create(() => ({ selected: 0, other: 0 }));
    const store = observeStoragePerformance(original, telemetry);
    const selectValue = (state: { selected: number }) => state.selected;
    let renders = 0;
    const hook = await renderHook(() => { renders++; return store(selectValue); });
    const initialRenders = renders;
    telemetry.reset();
    await act(async () => { store.setState({ other: 1 }); });
    expect(renders).toBe(initialRenders);
    expect(telemetry.snapshot().events.find(event => event.name === 'sync.store.storage.notify')?.count).toBe(1);
    const evaluated = telemetry.snapshot().events.find(event => event.name.startsWith('sync.store.storage.selector.'));
    expect(evaluated?.count).toBeGreaterThan(0);
    expect(evaluated?.fields.changed).toBe(0);
    await act(async () => { store.setState({ selected: 1 }); });
    expect(hook.getCurrent()).toBe(1);
    expect(telemetry.snapshot().events.find(event => event.name.startsWith('sync.store.storage.selector.'))?.fields.changed).toBe(1);
    await hook.unmount();
});

it('leaves telemetry empty when disabled and retains the original store API', async () => {
    const telemetry = createSyncPerformanceTelemetry({ enabled: false });
    const original = create(() => ({ value: 0 }));
    const store = observeStoragePerformance(original, telemetry);
    expect(store.getState).toBe(original.getState);
    expect(store.setState).toBe(original.setState);
    const hook = await renderHook(() => store(state => state.value));
    await act(async () => { original.setState({ value: 2 }); });
    expect(hook.getCurrent()).toBe(2);
    expect(telemetry.snapshot().events).toEqual([]);
    await hook.unmount();
});

it('aggregates recreated inline selectors under one stable name instead of allocating event ids per render', async () => {
    const telemetry = createSyncPerformanceTelemetry({ enabled: true });
    const store = observeStoragePerformance(create(() => ({ value: 0 })), telemetry);
    const hook = await renderHook(() => store(state => state.value));
    for (let value = 1; value <= 12; value++) {
        await act(async () => { store.setState({ value }); });
    }
    const events = telemetry.snapshot().events.filter(event => event.name.startsWith('sync.store.storage.selector.'));
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('sync.store.storage.selector.anonymous');
    expect(events[0].count).toBeGreaterThan(12);
    expect(hook.getCurrent()).toBe(12);
    await hook.unmount();
});
