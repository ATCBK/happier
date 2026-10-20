import { create } from 'zustand';
import { expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { createSyncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { observeStoragePerformance } from './storagePerformance';

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
