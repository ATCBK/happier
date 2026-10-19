import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * One server carries several HTTP Upgrade listeners: Socket.IO owns its own path, and the local
 * service preview and public data planes own their hosts and routes. Socket.IO's built-in cleanup
 * (`destroyUpgrade`) closes any upgrade that has written nothing within a fixed second, which kills
 * a relay WebSocket still waiting for its remote Machine. That cleanup is disabled and replaced by
 * this single rule: an upgrade that no listener claimed is closed, whenever claims are known.
 */
const claimedUpgrades = new WeakSet<object>();

/** A listener calls this synchronously, before its first await, for an upgrade it will answer. */
export function claimHttpUpgrade(request: object): void {
    claimedUpgrades.add(request);
}

export function destroyUnclaimedHttpUpgrades(server: Server, socketIoPath: string): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
        // Every listener has run its synchronous claim by the next turn of the event loop.
        setImmediate(() => {
            if (request.url?.startsWith(socketIoPath) || claimedUpgrades.has(request)) return;
            socket.destroy();
        });
    });
}
