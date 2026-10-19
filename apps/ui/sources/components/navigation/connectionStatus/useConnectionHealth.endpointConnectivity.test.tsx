import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { useConnectionHealth } = await import('./useConnectionHealth');
const initialStorageState = storage.getState();
let homeId = '';
let otherHomeId = '';

beforeEach(async () => {
    await homes.reset();
    homeId = await homes.addHome({ name: 'Endpoint Home', serverUrl: 'https://health-endpoint.test', accountId: 'endpoint-account' });
    otherHomeId = await homes.addHome({ name: 'Other Home', serverUrl: 'https://health-endpoint-other.test', accountId: 'other-account', active: false });
    await homes.selectHomes([homeId]);
    storage.getState().activateProfileScope({ serverId: homeId, accountId: 'endpoint-account' });
    storage.getState().applyMachines([], true, { sourceServerId: homeId, sourceAccountId: 'endpoint-account' });
    storage.getState().markMachineListSettled(homeId);
    storage.setState({ socketStatus: 'connected', endpointStatus: 'online', endpointReason: null, syncError: null });
});
afterEach(async () => {
    standardCleanup();
    await homes.reset();
    storage.setState(initialStorageState, true);
});

function applyMachines(machines: Parameters<typeof createMachineFixture>[0][], serverId = homeId) {
    storage.getState().applyMachines(machines.map(machine => createMachineFixture({ activeAt: Date.now(), ...machine })), true,
        { sourceServerId: serverId, sourceAccountId: serverId === homeId ? 'endpoint-account' : 'other-account' });
    storage.getState().markMachineListSettled(serverId);
}

describe('useConnectionHealth (endpoint connectivity integration)', () => {
    it('prioritizes endpoint offline over socket connected + sync errors', async () => {
        storage.setState({ endpointStatus: 'offline', syncError: {
            kind: 'network', message: 'Endpoint unavailable', retryable: true, at: Date.now(), serverId: homeId,
        } });
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent().kind).toBe('server_unreachable');
    });

    it('renders planned server restarts as neutral reconnect with known machine state', async () => {
        storage.setState({ endpointStatus: 'offline', endpointReason: 'server_restarting', socketStatus: 'disconnected' });
        applyMachines([{ id: 'm1', daemonState: { status: 'running' } }]);
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'server_restarting', tone: 'neutral',
            statusLabelKey: 'status.connecting', machineLabelKey: 'status.online' });
    });

    it('surfaces auth_required when endpoint auth_failed', async () => {
        storage.setState({ endpointStatus: 'auth_failed' });
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'auth_required', statusLabelKey: 'status.actionRequired' });
    });

    it('surfaces auth_required when a terminal auth sync error is present', async () => {
        storage.setState({ socketStatus: 'error', syncError: {
            kind: 'auth', message: 'Sign in again', retryable: false, at: Date.now(), serverId: homeId,
        } });
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'auth_required', statusLabelKey: 'status.actionRequired' });
    });

    it('ignores auth sync errors that belong to a different server profile', async () => {
        storage.setState({ syncError: {
            kind: 'auth', message: 'Other Home needs sign-in', retryable: false, at: Date.now(), serverId: otherHomeId,
        } });
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent().kind).toBe('no_machine');
    });

    it('surfaces machine_not_ready when machines are online but none are ready', async () => {
        applyMachines([
            { id: 'm1', daemonState: { status: 'offline' } },
            { id: 'm2', daemonState: { status: 'offline' } },
        ]);
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent()).toMatchObject({ kind: 'machine_not_ready',
            statusLabelKey: 'status.actionRequired', machineLabelKey: 'status.online' });
    });

    it('exposes primaryMachineLabel when exactly one machine is visible', async () => {
        applyMachines([{ id: 'm1', metadata: { ...createMachineFixture().metadata!, host: 'mbp' }, daemonState: { status: 'running' } }]);
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent().primaryMachineLabel).toBe('mbp');
    });

    it('updates when the active Home and device Home-view selection change', async () => {
        applyMachines([{ id: 'm1', metadata: { ...createMachineFixture().metadata!, host: 'alpha' }, daemonState: { status: 'running' } }]);
        applyMachines([{ id: 'm2', metadata: { ...createMachineFixture().metadata!, host: 'beta' }, daemonState: { status: 'running' } }], otherHomeId);
        const hook = await renderHook(useConnectionHealth);
        expect(hook.getCurrent().primaryMachineLabel).toBe('alpha');

        await act(async () => {
            await setActiveServerId(otherHomeId);
            await homes.selectHomes([otherHomeId]);
            storage.getState().activateProfileScope({ serverId: otherHomeId, accountId: 'other-account' });
            applyMachines([{ id: 'm2', metadata: { ...createMachineFixture().metadata!, host: 'beta' }, daemonState: { status: 'running' } }], otherHomeId);
        });
        await flushHookEffects();

        expect(hook.getCurrent().primaryMachineLabel).toBe('beta');
    });
});
