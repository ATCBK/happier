import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedGuestActivityTransport } from './managedActivityTransport';

const machine = ManagedMachineV1Schema.parse({
    id: 'managed', homeId: 'srv_home', custodianAccountId: 'owner',
    controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
    allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' }, wakeOnAcceptedMessage: false,
});

async function withPendingConnection(run: (endpoint: string, connecting: Promise<void>) => Promise<void>) {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    let attempted!: () => void;
    const connecting = new Promise<void>(resolve => { attempted = resolve; });
    // The Home/socket boundary holds authentication before readiness, as can happen during startup.
    server.use(() => { attempted(); });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing activity socket endpoint');
        await run(`http://127.0.0.1:${address.port}`, connecting);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

async function withConnectedTransport(run: (bridge: ReturnType<typeof createManagedGuestActivityTransport>, socket: Socket) => Promise<void>) {
    const http = createServer();
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const connected = new Promise<Socket>(resolve => server.once('connection', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing activity socket endpoint');
    const bridge = createManagedGuestActivityTransport({ token: 'owner-token',
        serverUrl: `http://127.0.0.1:${address.port}`,
        credentials: { token: 'owner-token', encryption: null } }, { requestId: 'retention' }, machine);
    try {
        await run(bridge, await connected);
    } finally {
        await bridge.dispose?.();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

describe('managed activity transport lifetime', () => {
    it('classifies 60 unrelated Account wakes as currentness and the target Machine wake as activity', async () => {
        await withConnectedTransport(async (bridge, socket) => {
            // Connection itself invalidates the prior observation.
            await expect(bridge.waitForChange()).resolves.toBe('activity');
            for (let seq = 1; seq <= 60; seq++) {
                const changed = bridge.waitForChange();
                socket.emit('update', { id: `account-${seq}`, seq, createdAt: seq,
                    body: { t: 'account-change' } });
                await expect(changed).resolves.toBe('currentness');
            }
            const changed = bridge.waitForChange();
            socket.emit('update', { id: 'target-machine', seq: 61, createdAt: 61,
                body: { t: 'update-machine', machineId: machine.enrolledMachineId } });
            await expect(changed).resolves.toBe('activity');
        });
    });
    it.each([false, true])('disposes before readiness without an unhandled rejection (waiting reader=%s)', async waitingReader => {
        await withPendingConnection(async (serverUrl, connecting) => {
            const rejections: unknown[] = [];
            const onUnhandled = (error: unknown) => { rejections.push(error); };
            process.on('unhandledRejection', onUnhandled);
            const bridge = createManagedGuestActivityTransport({ token: 'owner-token', serverUrl,
                credentials: { token: 'owner-token', encryption: null } }, { requestId: 'retention' }, machine);
            const pending = waitingReader ? bridge.waitForChange().then(() => undefined, (error: unknown) => error) : undefined;
            try {
                await connecting;
                await bridge.dispose?.();
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(rejections).toEqual([]);
                if (pending) expect(await pending).toMatchObject({ name: 'AbortError' });
                // Disposal must keep the original readiness failure for a later consumer too.
                await expect(bridge.waitForChange()).rejects.toMatchObject({ name: 'AbortError' });
            } finally {
                await bridge.dispose?.();
                await bridge.waitForChange().catch(() => undefined);
                process.off('unhandledRejection', onUnhandled);
            }
        });
    });
});
