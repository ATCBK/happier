import type { StoreApi, UseBoundStore } from 'zustand';
import type { SyncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';

export function observeStoragePerformance<T>(store: UseBoundStore<StoreApi<T>>, telemetry: SyncPerformanceTelemetry): UseBoundStore<StoreApi<T>> {
    const selectors = new WeakMap<(state: T) => unknown, (state: T) => unknown>();
    const identity = (state: T) => state;

    // Observe actual Zustand notifications, including writes through the
    // captured domain setter and the public setState API. Never read values.
    store.subscribe(() => telemetry.count('sync.store.storage.notify'));

    function useObservedStore(): T;
    function useObservedStore<U>(selector: (state: T) => U): U;
    function useObservedStore<U>(selector?: (state: T) => U): T | U {
        const select: (state: T) => T | U = selector ?? identity;
        if (!telemetry.isEnabled()) return store(select);
        let observed = selectors.get(select);
        if (!observed) {
            // Weak keys preserve wrapper identity without retaining abandoned closures.
            const name = select.name.replace(/[^a-zA-Z0-9_]/g, '') || 'anonymous';
            // Inline closures are recreated on every render. Aggregate by name,
            // not function identity; anonymous selectors deliberately share a bucket.
            const event = `sync.store.storage.selector.${name}`;
            let initialized = false;
            let previous: T | U;
            observed = (state) => {
                if (!telemetry.isEnabled()) return select(state);
                const selected = select(state);
                telemetry.count(event, { initial: initialized ? 0 : 1, changed: initialized && !Object.is(previous, selected) ? 1 : 0 });
                initialized = true;
                previous = selected;
                return selected;
            };
            selectors.set(select, observed);
        }
        // Each cached wrapper is paired with exactly this typed selector key.
        return store(observed as (state: T) => T | U);
    }

    return Object.assign(useObservedStore, store);
}
