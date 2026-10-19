import { afterEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { resolveConnectionHealth } from '@/components/navigation/connectionStatus/resolveConnectionHealth';

import { bindSocketErrorToRealtimeStore } from './bindSocketErrorToRealtimeStore';

describe('primary socket error recovery', () => {
    afterEach(() => {
        storage.getState().setSocketError(null);
        storage.getState().clearSyncError();
    });

    function socketErrorChannel() {
        // The socket's external error/recovery notification is the boundary. Store and classification stay real.
        const listeners = new Set<(error: Error | null) => void>();
        const detach = bindSocketErrorToRealtimeStore((listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        });
        return { emit: (error: Error | null) => listeners.forEach((listener) => listener(error)), detach };
    }

    it('removes the stale Home error after a successful primary socket connection', () => {
        const channel = socketErrorChannel();
        try {
            channel.emit(new Error('Socket disconnected before connect'));
            expect(storage.getState().syncError).toMatchObject({ retryable: true, kind: 'unknown' });
            channel.emit(null);
            const state = storage.getState();
            expect(state.socketLastError).toBeNull();
            expect(state.syncError).toBeNull();
            expect(resolveConnectionHealth({ socketStatus: 'connected', endpointStatus: 'online',
                hasSyncError: !!state.syncError, machineGroups: [{ machineCount: 1, onlineCount: 1, readyCount: 1, status: 'idle' }] }).kind)
                .toBe('healthy');
        } finally { channel.detach(); }
    });

    it('preserves an intervening sync failure even when its message matches the socket error', () => {
        const channel = socketErrorChannel();
        try {
            channel.emit(new Error('Socket disconnected before connect'));
            const previous = storage.getState().syncError!;
            const failure = { message: previous.message, kind: previous.kind, retryable: previous.retryable, at: previous.at };
            storage.getState().setSyncError(failure);
            channel.emit(null);
            expect(storage.getState().socketLastError).toBeNull();
            expect(storage.getState().syncError).toBe(failure);
        } finally { channel.detach(); }
    });

    it('clears its socket error after a sync retry has refreshed the retry metadata', () => {
        const channel = socketErrorChannel();
        try {
            channel.emit(new Error('Socket disconnected before connect'));
            storage.getState().setSyncError({ ...storage.getState().syncError!, failuresCount: 1, nextRetryAt: 100 });
            channel.emit(null);
            expect(storage.getState().syncError).toBeNull();
        } finally { channel.detach(); }
    });

    it('does not restore a socket error already superseded by successful sync', () => {
        const channel = socketErrorChannel();
        try {
            channel.emit(new Error('Socket disconnected before connect'));
            storage.getState().clearSyncError();
            channel.emit(null);
            expect(storage.getState().syncError).toBeNull();
        } finally { channel.detach(); }
    });
});
