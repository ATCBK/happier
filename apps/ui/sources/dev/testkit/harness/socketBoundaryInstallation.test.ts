import { describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('./serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

describe('Socket transport boundary installation', () => {
    it('supports a hoisted static consumer and reconfiguration after importOriginal loads the SDK', async () => {
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'first' }; });
        const first = io('https://import-order.test', { autoConnect: false });
        expect(first.auth).toEqual({ fixture: 'first' });
        expect(first.connect()).toBe(first);
        expect(first.connected).toBe(false);
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'second' }; });
        const second = io('https://import-order.test', { autoConnect: false });
        expect(second.auth).toEqual({ fixture: 'second' });
        expect(second.connect()).toBe(second);
        expect(second.connected).toBe(false);
        // A subsequent import processes queued doMock registrations and evicts
        // the mock cache. Existing consumers still hold the valid delegate.
        await import('../hooks/createDeferred');
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'third' }; });
        const third = io('https://import-order.test', { autoConnect: false });
        expect(third.auth).toEqual({ fixture: 'third' });
        first.disconnect();
        second.disconnect();
        third.disconnect();
    });
});
