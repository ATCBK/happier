import { describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

describe('Socket transport boundary import order', () => {
    it('rejects installation after a static consumer captured the real disconnected Socket factory', () => {
        // autoConnect:false proves the captured factory without opening a network connection.
        const socket = io('https://import-order.test', { autoConnect: false });
        expect(socket.connected).toBe(false);
        expect(vi.isMockFunction(socket.connect)).toBe(false);
        socket.disconnect();
        expect(() => installDisconnectedServerSocketBoundary()).toThrowError(
            /installDisconnectedServerSocketBoundary.*socket.io-client.*before.*dynamic import/s,
        );
    });
});
