import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded, withdrawMachinePresenceForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useConnectionHealth } = await import('./useConnectionHealth');
const before = storage.getState();

afterEach(() => {
    standardCleanup();
    storage.setState(before, true);
    clearMachineRequestReachabilityForTest();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    network.resetRequests();
});
afterAll(() => network.dispose());

async function setup(locked = false) {
    const home = await network.addHome(`https://connection-fleet-${locked ? 'locked' : 'ready'}.test`, 'account-fleet');
    setActiveServerId(home.id);
    const serverId = home.id;
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), daemonState: { status: 'running' },
        ...(locked ? { availability: { kind: 'locked', reason: 'decryption_failed' } as const } : {}) });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
        machineListStatusByServerId: { [serverId]: 'idle' }, socketStatus: 'connected', endpointStatus: 'online', syncError: null });
    const hook = await renderHook(() => useConnectionHealth());
    return { serverId, machine, hook };
}

describe('connection health fleet readiness', () => {
    it('keeps withdrawn presence unknown until the exact Home and Account observes the machine again', async () => {
        const { serverId, machine, hook } = await setup();
        const scope = { serverId, accountId: 'account-fleet' };
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_unknown', machineCount: 1, onlineCount: 0,
            hasUnknownMachines: true, machineLabelKey: 'status.unknown', tone: 'neutral', isPulsing: false });
        await act(async () => {
            captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })([machine.id]);
            captureMachinePresenceObservation({ ...scope, serverId: 'another-home' })([machine.id]);
        });
        expect(hook.getCurrent().machineLabelKey).toBe('status.unknown');
        await act(async () => captureMachinePresenceObservation(scope)([machine.id]));
        expect(hook.getCurrent()).toMatchObject({ kind: 'healthy', onlineCount: 1, hasUnknownMachines: false });
    });

    it('retains locked inventory and socket presence without presenting executable readiness', async () => {
        const { hook } = await setup(true);
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_not_ready', machineCount: 1, onlineCount: 1, socketStatus: 'connected' });
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });

    it('refreshes exact-Home request failure and recovery without changing raw socket diagnostics', async () => {
        const { serverId, machine, hook } = await setup();
        expect(hook.getCurrent().kind).toBe('healthy');
        await act(async () => recordMachineRequestFailed({ serverId, accountId: 'account-fleet', machineId: machine.id }));
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_offline', machineCount: 1, onlineCount: 0, socketStatus: 'connected' });
        await act(async () => recordMachineRequestSucceeded({ serverId: 'other-home', accountId: 'account-fleet', machineId: machine.id }));
        expect(hook.getCurrent().kind).toBe('machine_offline');
        await act(async () => recordMachineRequestSucceeded({ serverId, accountId: 'account-fleet', machineId: machine.id }));
        expect(hook.getCurrent().kind).toBe('healthy');
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });
});
