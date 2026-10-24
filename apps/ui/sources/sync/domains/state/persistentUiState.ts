import { useCallback, useSyncExternalStore } from 'react';
import { getPersistenceStorage, subscribePersistenceStorageCleared } from './persistenceStorage';

/** A refused device write is recoverable; serialization/programmer errors are not. */
export class UiStatePersistenceError extends Error {
    constructor(readonly cause: unknown) {
        super(cause instanceof Error ? cause.message : 'Failed to persist UI state');
        this.name = 'UiStatePersistenceError';
    }
}

/** Keyed projections over the existing device KV owner, never another settings blob. */
export function createPersistentUiState<T>(namespace: string, parse: (value: unknown) => T) {
    const prefix = `ui-state:${namespace}:`;
    const values = new Map<string, T>();
    let snapshot: Readonly<Record<string, T>> | undefined;
    const loadedKeys = new Set<string>();
    let allLoaded = false;
    const listeners = new Set<() => void>();
    const keyedListeners = new Map<string, Set<() => void>>();
    subscribePersistenceStorageCleared(() => {
        const previousKeys = new Set(values.keys());
        values.clear();
        snapshot = undefined;
        loadedKeys.clear();
        allLoaded = false;
        for (const listener of listeners) listener();
        for (const [key, subscriptions] of keyedListeners) {
            if (previousKeys.has(key)) for (const listener of subscriptions) listener();
        }
    });
    const readStrict = (key: string): T | undefined => {
        if (!loadedKeys.has(key)) {
            let raw: string | undefined;
            try { raw = getPersistenceStorage().getString(prefix + key); }
            catch (error) { throw new UiStatePersistenceError(error); }
            if (raw !== undefined) {
                let value: unknown;
                try { value = JSON.parse(raw); } catch { value = null; }
                values.set(key, parse(value));
                snapshot = undefined;
            }
            loadedKeys.add(key);
        }
        return values.get(key);
    };
    const read = (key: string): T | undefined => {
        try { return readStrict(key); } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[ui-state] Device state could not be read.');
            return undefined;
        }
    };
    const readAll = (): Readonly<Record<string, T>> => {
        if (!allLoaded) {
            let keys: string[];
            try { keys = getPersistenceStorage().getAllKeys(); }
            catch {
                console.warn('[ui-state] Device state could not be read.');
                return snapshot ??= Object.fromEntries(values);
            }
            for (const key of keys) if (key.startsWith(prefix)) read(key.slice(prefix.length));
            allLoaded = true;
        }
        return snapshot ??= Object.fromEntries(values);
    };
    const publish = (key: string) => {
        snapshot = undefined;
        for (const listener of listeners) listener();
        for (const listener of keyedListeners.get(key) ?? []) listener();
    };
    const set = (key: string, value: T): void => {
        if (read(key) === value && values.has(key)) return;
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new TypeError('UI state must be JSON serializable');
        const storage = getPersistenceStorage();
        try {
            if (storage.getString(prefix + key) === serialized) return;
            storage.set(prefix + key, serialized);
        } catch (error) { throw new UiStatePersistenceError(error); }
        values.set(key, value);
        publish(key);
    };
    const remove = (key: string): void => {
        read(key);
        if (!values.has(key)) return;
        try { getPersistenceStorage().delete(prefix + key); } catch (error) { throw new UiStatePersistenceError(error); }
        values.delete(key);
        publish(key);
    };
    return {
        readAll,
        read,
        readStrict,
        set,
        remove,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeKey: (key: string, listener: () => void) => {
            let subscriptions = keyedListeners.get(key);
            if (!subscriptions) keyedListeners.set(key, subscriptions = new Set());
            subscriptions.add(listener);
            return () => {
                subscriptions.delete(listener);
                if (!subscriptions.size) keyedListeners.delete(key);
            };
        },
    };
}

export function usePersistentUiStateValue<T>(state: ReturnType<typeof createPersistentUiState<T>>, key: string | null): T | undefined {
    const subscribe = useCallback((listener: () => void) => key === null ? () => {} : state.subscribeKey(key, listener), [key, state]);
    const read = useCallback(() => key === null ? undefined : state.read(key), [key, state]);
    return useSyncExternalStore(subscribe, read, read);
}
