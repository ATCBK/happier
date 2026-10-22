import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { apiSocket } = await import('./apiSocket');
const owner = await import('@/sync/domains/machines/reachability/machineReachability');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
const disposers: Array<() => void> = [];

beforeEach(async () => {
    boundary.resetRequests();
    owner.clearMachineRequestReachabilityForTest();
    home = await boundary.addHome('https://reachability.example.test', 'account-a');
    apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
        request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); apiSocket.disconnect(); owner.clearMachineRequestReachabilityForTest(); vi.useRealTimers(); });
afterAll(() => boundary.dispose());

describe('Machine reachability through the authenticated socket ingress', () => {
    it('restores presence through an admitted HTTP census only for its captured Home and Account', async () => {
        const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { createDeferred } = await import('@/dev/testkit');
        const { fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
        const { resolveMachinePickerPresence } = await import('@/sync/domains/machines/identity/resolveMachinePickerPresence');
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const now = Date.now();
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: scope.accountId }), active: false, activeAt: now - 97_000 };
        const machine = { id: row.id, active: true, activeAt: row.activeAt };
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const read = (serverId: string, request: () => Promise<Response>, token = home.token) => fetchAndApplyMachines({
            credentials: { token }, sourceServerId: serverId, expectedAccountMode: 'plain',
            encryption: null, machineDataKeys: new Map(), request, applyMachines: () => {},
        });
        const pending = read(home.id, async () => { entered.resolve(); await release.promise; return Response.json([row]); });
        await entered.promise;
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        release.resolve();
        await pending;
        // A census already in flight at withdrawal cannot bless retained presence.
        expect.soft(resolveMachinePickerPresence(machine, now, scope).status).toBe('unknown');
        await read('another-home', async () => Response.json([row]));
        expect.soft(resolveMachinePickerPresence(machine, now, scope).status).toBe('unknown');
        const other = await boundary.addHome('https://presence-other-account.example.test', 'account-b');
        await read(home.id, async () => Response.json([row]), other.token);
        expect.soft(resolveMachinePickerPresence(machine, now, scope).status).toBe('unknown');
        await read(home.id, async () => Response.json([row]));
        expect(resolveMachinePickerPresence({ ...machine, active: false }, now, scope).status).toBe('offline');
    });
    it('withdraws retained presence across own loss and reconnect until exact-scope fresh presence arrives', async () => {
        const { resolveMachinePickerPresence } = await import('@/sync/domains/machines/identity/resolveMachinePickerPresence');
        const { resolveMachineSpawnReadiness, canAttemptMachineSpawn } = await import('@/sync/domains/machines/identity/resolveMachineSpawnReadiness');
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const now = Date.now();
        const machine = { id: 'machine', active: true, activeAt: now };
        const { MachineActivityAccumulator } = await import('@/sync/engine/activity/machineActivityAccumulator');
        const accumulator = new MachineActivityAccumulator((updates, options) => {
            for (const update of updates.values()) if (update.id === machine.id) Object.assign(machine, { active: update.active, activeAt: update.activeAt });
            options?.onApplied?.();
        });
        const unsubscribe = apiSocket.onMessage('ephemeral', (raw) => {
            const { success, data } = EphemeralUpdateSchema.safeParse(raw);
            if (!success || data.type !== 'machine-activity') return;
            const observe = owner.captureMachinePresenceObservation(scope);
            accumulator.addUpdate(data, { sourceServerId: scope.serverId, onApplied: () => observe([data.id]) });
        });
        disposers.push(() => { unsubscribe(); accumulator.reset(); });
        // Warm the canonical accumulator so the next same-state heartbeat is queued.
        accumulator.addUpdate(machine, { sourceServerId: scope.serverId });
        expect(resolveMachinePickerPresence(machine, now, scope).status).toBe('online');
        socket.trigger('disconnect', 'transport close');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now + 97_000);
        const checkUnknown = () => {
            expect.soft(resolveMachinePickerPresence(machine, Date.now(), scope)).toEqual({ status: 'unknown', selectable: false });
            expect.soft(owner.isMachineReachable(scope, machine)).toBe(false);
            expect.soft(resolveMachineSpawnReadiness({ selectedMachineId: machine.id, machine, scope }).status).toBe('unknown');
            expect.soft(resolveMachineSpawnReadiness({ selectedMachineId: machine.id, machine, scope, machineReachable: false }).status).toBe('unknown');
            expect.soft(canAttemptMachineSpawn({ selectedMachineId: machine.id, machine, scope })).toBe(false);
        };
        checkUnknown();
        socket.trigger('connect');
        checkUnknown();
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'another-machine', active: true, activeAt: Date.now() });
        checkUnknown();
        // Other Home/Account facts are not withdrawn by this socket.
        expect(resolveMachinePickerPresence(machine, now, { ...scope, accountId: 'account-b' }).status).toBe('online');
        expect(resolveMachinePickerPresence(machine, now, { ...scope, serverId: 'another-home' }).status).toBe('online');
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: true, activeAt: Date.now() });
        expect(owner.resolveMachineReachability(scope, machine)).toBe('unknown');
        accumulator.flush();
        expect(resolveMachinePickerPresence({ ...machine, activeAt: Date.now() }, Date.now(), scope).status).toBe('online');
        expect(owner.resolveMachineReachability(scope, { ...machine, revokedAt: now })).toBe('unreachable');
        // A real offline observation must restore the ordinary offline verdict.
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        vi.setSystemTime(now + 194_000);
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: false, activeAt: now + 97_001 });
        expect(resolveMachinePickerPresence({ ...machine, active: false }, Date.now(), scope).status).toBe('offline');
    });
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
        expect(owner.resolveMachineReachability(scope, { id: 'unaffected', active: true })).toBe('unknown');
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 100, reconnected: true });
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
    });
});
