import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { vi } from 'vitest';
import * as sockets from '@/api/session/sockets';
import type { Socket } from 'socket.io-client';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
const createUserScopedSocketConnection = sockets.createUserScopedSocketConnection;

export type RequesterCurrentnessSocketHarness = Readonly<{
    server: Server;
    clients: Socket[];
    disconnect(): Promise<void>;
    reconnect(): Promise<void>;
    pushProfile(accountId: string): Promise<void>;
    pushSettings(accountId: string, settings: unknown, version: number): Promise<void>;
    hintSettings(settingsVersion: number): Promise<void>;
    hintAccountChange(): Promise<void>;
    pushInvalidCurrentness(accountId: string): Promise<void>;
    pushInvalidSettings(accountId: string): Promise<void>;
    push(accountId: string, currentness: unknown): Promise<void>;
    close(): Promise<void>;
}>;

/** Real Socket.IO channel; only the network endpoint is redirected from Home to loopback. */
export async function createRequesterCurrentnessSocketHarness(): Promise<RequesterCurrentnessSocketHarness> {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing socket listen address');
    const clients: Socket[] = [];
    const redirect = vi.spyOn(sockets, 'createUserScopedSocketConnection').mockImplementation(options => {
        const connection = createUserScopedSocketConnection({ ...options, serverUrl: `http://127.0.0.1:${address.port}` });
        // This is the genuine network socket, with default event typing at the test boundary.
        const client = connection.socket as Socket;
        client.on('fx56-delivered', (ack: () => void) => ack());
        clients.push(client);
        return connection;
    });
    const deliver = async (body: unknown) => {
        await Promise.all([...server.sockets.sockets.values()].map(socket => new Promise<void>(resolve => {
            socket.emit('update', { id: 'encryption-change', seq: 2, createdAt: 2, body });
            socket.emit('fx56-delivered', resolve);
        })));
    };
    return {
        server,
        clients,
        async disconnect() {
            clients.forEach(client => client.disconnect());
        },
        async reconnect() {
            await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
                client.connect();
            })));
        },
        async pushProfile(accountId: string) {
            await deliver(UpdateBodySchema.parse({ t: 'update-account', id: accountId, name: 'Changed profile' }));
        },
        async pushSettings(accountId: string, settings: unknown, version: number) {
            await deliver(UpdateBodySchema.parse({ t: 'update-account', id: accountId,
                settingsV2: { content: { t: 'plain', v: settings }, version } }));
        },
        async hintSettings(settingsVersion: number) {
            await deliver(UpdateBodySchema.parse({ t: 'account-settings-changed', settingsVersion }));
        },
        async hintAccountChange() {
            await deliver(UpdateBodySchema.parse({ t: 'account-change' }));
        },
        pushInvalidCurrentness: async (accountId: string) => await deliver({ t: 'update-account', id: accountId,
            encryptionCurrentness: { mode: 'unknown' } }),
        pushInvalidSettings: async (accountId: string) => await deliver({ t: 'update-account', id: accountId,
            settingsV2: { version: 'invalid', content: { t: 'plain', v: {} } } }),
        async push(accountId: string, currentness: unknown) {
            const body = UpdateBodySchema.parse({ t: 'update-account', id: accountId,
                encryptionCurrentness: currentness === null ? null : AccountEncryptionCurrentnessResponseSchema.parse(currentness) });
            await deliver(body);
        },
        async close() {
            redirect.mockRestore();
            clients.forEach(client => client.disconnect());
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
