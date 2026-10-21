import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { ApiMachineClient } from './apiMachine';
import type { MachineRpcAdmissionBoundary } from './machine/machineRpcAuthorization';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo }));

it.each(['profile', 'currentness'] as const)('lets an admission joiner cancel without cancelling shared Account identity acquisition (%s)', async phase => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    // Hold only Home HTTP; identity, currentness and the installed admission reader stay real.
    const network = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) {
            if (phase === 'profile') { entered = true; await held; }
            return { status: 200, data: { id: 'owner' } };
        }
        expect(String(url)).toContain('/v1/account/encryption/currentness');
        entered = true;
        await held;
        return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null } };
    });
    socketIo.mockImplementation(() => createApiSessionSocketStub());
    const token = phase === 'profile' ? 'opaque-daemon-token'
        : `test.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const boundary: MachineRpcAdmissionBoundary = Reflect.get(client, 'machineRpcAdmissionBoundary');
    const owner = boundary.resolveCustodianAccountId();
    const cancellation = new AbortController();
    let joined = false;
    let joinedError: unknown;
    try {
        await vi.waitFor(() => expect(entered).toBe(true));
        const joiner = boundary.resolveCustodianAccountId(cancellation.signal).then(
            () => { joined = true; }, error => { joined = true; joinedError = error; });
        const reason = new Error('admission reader retired');
        cancellation.abort(reason);
        await vi.waitFor(() => expect(joined).toBe(true));
        expect(joinedError).toBe(reason);
        release();
        expect(await owner).toBe('owner');
        await joiner;
        expect(await boundary.resolveCustodianAccountId()).toBe('owner');
        expect(network.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile'))).toHaveLength(1);
    } finally { release(); await owner; await client.shutdown(); network.mockRestore(); }
});
