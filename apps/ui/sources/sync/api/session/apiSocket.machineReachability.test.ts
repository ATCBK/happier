import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { apiSocket } = await import('./apiSocket');
const owner = await import('@/sync/domains/machines/reachability/machineReachability');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

beforeEach(async () => {
    boundary.resetRequests();
    owner.clearMachineRequestReachabilityForTest();
    home = await boundary.addHome('https://reachability.example.test', 'account-a');
    apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
        request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
});
afterEach(() => { apiSocket.disconnect(); owner.clearMachineRequestReachabilityForTest(); });
afterAll(() => boundary.dispose());

describe('Machine reachability through the authenticated socket ingress', () => {
    it('keeps a request-scoped Forbidden response from poisoning Machine reachability through the real scoped RPC owner', async () => {
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { RPC_ERROR_CODES, RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const scope = { serverId: home.id, accountId: 'account-a' };
        boundary.setRpcAckResponder(async request => request.method === RPC_METHODS.CAPABILITIES_DESCRIBE
            ? { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN }
            : { ok: true, result: { available: true } });
        const call = (method: string) => machineRpcWithServerScope({ ...scope, machineId: 'machine', method,
            payload: {}, preferScoped: true, onIssued: () => {} });
        await expect(call(RPC_METHODS.CAPABILITIES_DESCRIBE)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.isMachineReachable(scope, { id: 'machine', active: true })).toBe(true);
        await expect(call(RPC_METHODS.DAEMON_MEMORY_STATUS)).resolves.toEqual({ available: true });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('succeeded');
    });
    it('preserves heartbeat failures and heals only the re-established socket Home and Account', () => {
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const otherAccount = { ...scope, accountId: 'account-b' };
        const otherHome = { ...scope, serverId: 'other-home' };
        for (const identity of [scope, otherAccount, otherHome]) {
            owner.recordMachineRequestFailed({ ...identity, machineId: 'machine' });
            owner.recordMachineRequestFailed({ ...identity, machineId: 'machine', route: 'loopback_direct' });
        }
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: Date.now() });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine', 'loopback_direct')?.outcome).toBe('failed');
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine', 'loopback_direct')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(otherAccount, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherHome, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherAccount, 'machine', 'loopback_direct')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherHome, 'machine', 'loopback_direct')?.outcome).toBe('failed');
    });

    it('heals only the admitted Machine reconnect and ignores malformed, inactive and retired ingress', () => {
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        owner.recordMachineRequestFailed({ ...scope, machineId: 'other-machine' });
        owner.recordMachineRequestFailed({ ...scope, accountId: 'account-b', machineId: 'machine' });
        for (const payload of [
            { type: 'machine-activity', id: 'machine', active: true, activeAt: 100 },
            { type: 'machine-activity', id: 'machine', active: true, activeAt: 100, reconnected: 'true' },
            { type: 'machine-activity', id: 'machine', active: false, activeAt: 100, reconnected: true },
        ]) {
            socket.trigger('ephemeral', payload);
            expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
        }
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 101, reconnected: true });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(scope, 'other-machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation({ ...scope, accountId: 'account-b' }, 'machine')?.outcome).toBe('failed');
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        apiSocket.disconnect();
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 102, reconnected: true });
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
    });

    it('never gives a Session-scoped socket Account-wide Machine recovery authority', async () => {
        apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
            socketRole: { clientType: 'session-scoped', sessionId: 'frame-session' },
            request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
        await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 100, reconnected: true });
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
    });
});
