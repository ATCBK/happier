import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createRealtimeDomain, type EndpointConnectivitySnapshot, type RealtimeDomain } from './realtime';

describe('realtime sync-error publication', () => {
    it('keeps equal status/error snapshots quiet and publishes real time boundaries', () => {
        const store = createStore<RealtimeDomain>()((set) => createRealtimeDomain({ set }));
        const failure = { message: 'Unavailable', retryable: true, kind: 'network' as const, at: 1 };
        store.getState().setSyncError(failure);
        store.getState().applyNativeUpdateStatus({ available: true, updateUrl: '/update' });
        store.getState().setAccountSettingsSyncStatus({ state: 'synced', lastSyncedAt: 10 });
        store.getState().setLastSyncAt(10);
        const before = store.getState();
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        store.getState().setSyncError({ ...failure });
        store.getState().applyNativeUpdateStatus({ available: true, updateUrl: '/update' });
        store.getState().setAccountSettingsSyncStatus({ state: 'synced', lastSyncedAt: 10 });
        store.getState().setLastSyncAt(10);
        store.getState().setSocketError(null);
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
        store.getState().setSyncError({ ...failure, at: 2 });
        store.getState().setAccountSettingsSyncStatus({ state: 'synced', lastSyncedAt: 11 });
        store.getState().setLastSyncAt(11);
        expect(notify).toHaveBeenCalledTimes(3);
        store.getState().resetAccountSettingsSyncStatus();
        const idle = store.getState();
        store.getState().resetAccountSettingsSyncStatus();
        expect(store.getState()).toBe(idle);
        unsubscribe();
    });
    it('publishes connection transitions, preserving timestamps and suppressing identical status snapshots', () => {
        vi.spyOn(Date, 'now').mockReturnValue(100);
        const store = createStore<RealtimeDomain>()((set) => createRealtimeDomain({ set }));
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        try {
            store.getState().setSocketStatus('connected');
            const connected = store.getState();
            vi.mocked(Date.now).mockReturnValue(200);
            store.getState().setSocketStatus('connected');
            expect(store.getState()).toBe(connected);
            expect(store.getState().socketLastConnectedAt).toBe(100);
            expect(notify).toHaveBeenCalledTimes(1);
            const snapshot: EndpointConnectivitySnapshot = { status: 'online', reason: null, attempt: 1,
                nextRetryAt: null, lastConnectedAt: 100, lastDisconnectedAt: null, lastErrorMessage: null };
            store.getState().setEndpointConnectivity(snapshot);
            const online = store.getState();
            store.getState().setEndpointConnectivity({ ...snapshot });
            expect(store.getState()).toBe(online);
            expect(notify).toHaveBeenCalledTimes(2);
            store.getState().setEndpointConnectivity({ ...snapshot, attempt: 2 });
            expect(store.getState().endpointAttempt).toBe(2);
            expect(notify).toHaveBeenCalledTimes(3);
            store.getState().setSocketStatus('disconnected');
            expect(store.getState().socketLastDisconnectedAt).toBe(200);
            store.getState().resetEndpointConnectivity();
            const reset = store.getState();
            store.getState().resetEndpointConnectivity();
            expect(store.getState()).toBe(reset);
            store.getState().setSocketStatus('connected');
            store.getState().setSocketError('Previous connection failed');
            vi.mocked(Date.now).mockReturnValue(300);
            store.getState().setSocketStatus('connected');
            expect(store.getState().socketLastError).toBeNull();
            expect(store.getState().socketLastErrorAt).toBeNull();
            expect(store.getState().socketLastConnectedAt).toBe(300);
        } finally { unsubscribe(); vi.restoreAllMocks(); }
    });

    it('notifies on an error and its recovery, but not on repeated already-clear success', () => {
        const store = createStore<RealtimeDomain>()((set) => createRealtimeDomain({ set }));
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        const initial = store.getState();

        store.getState().clearSyncError();
        store.getState().setSyncError(null);
        expect(store.getState()).toBe(initial);
        expect(notify).not.toHaveBeenCalled();

        const failure = { message: 'Unavailable', retryable: true, kind: 'network' as const, at: 1 };
        store.getState().setSyncError(failure);
        expect(store.getState().syncError).toBe(failure);
        expect(notify).toHaveBeenCalledTimes(1);
        const failed = store.getState();
        store.getState().setSyncError(failure);
        expect(store.getState()).toBe(failed);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().clearSyncError();
        expect(store.getState().syncError).toBeNull();
        expect(notify).toHaveBeenCalledTimes(2);
        const recovered = store.getState();
        store.getState().clearSyncError();
        expect(store.getState()).toBe(recovered);
        expect(notify).toHaveBeenCalledTimes(2);

        store.getState().setSyncError({ ...failure, at: 2 });
        expect(store.getState().syncError?.at).toBe(2);
        expect(notify).toHaveBeenCalledTimes(3);
        unsubscribe();
    });
});
