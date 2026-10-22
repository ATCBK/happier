import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storage');
const { useSessionMachineReachability, useSessionReachableMachineTarget } = await import('./useSessionMachineReachability');

const initialStorage = getStorage().getState();
const serverId = 'srv_session_reach';
beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Reachability Home', serverUrl: 'https://reachability.example.test',
        serverIdentityId: serverId, accountId: 'account' });
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now() });
    const session = createSessionFixture({ id: 's1', serverId, active: true, metadata: { machineId: 'm1', path: '/repo', host: 'host-1' } });
    getStorage().setState({ sessions: { s1: session }, machines: { m1: machine }, machineListByServerId: { [serverId]: [machine] } });
});
afterEach(async () => { standardCleanup(); clearMachineRequestReachabilityForTest(); vi.useRealTimers(); getStorage().setState(initialStorage, true); await home.reset(); });

describe('useSessionMachineReachability', () => {
    it('does not admit retained unobserved presence through the invisible shared-Machine exception', async () => {
        const hook = await renderHook(() => useSessionMachineReachability('s1', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineOnline).toBe(true));
        const scope = { serverId, accountId: 'account' };
        await act(async () => { withdrawMachinePresenceForScope(scope); });
        expect(hook.getCurrent()).toMatchObject({ machineReachability: 'unknown', machineOnline: false,
            machineReachable: false, machineRpcTargetAvailable: false, machineLastSeenAt: null });
        await act(async () => { captureMachinePresenceObservation(scope)(['m1']); });
        expect(hook.getCurrent()).toMatchObject({ machineReachability: 'reachable', machineReachable: true });
    });
    it('normalizes session ids before resolving the reachable machine target', async () => {
        const hook = await renderHook(() => useSessionReachableMachineTarget('  s1  ', serverId));
        expect(hook.getCurrent()).toEqual({ machineId: 'm1', basePath: '/repo' });
    });

    it('normalizes session ids and observes offline status even when no RPC target is available', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const hook = await renderHook(() => useSessionMachineReachability('  s1  ', serverId));
        const lastHeartbeat = getStorage().getState().machines.m1!.activeAt;
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable', machineLastSeenAt: null });
        await act(async () => { vi.advanceTimersByTime(60_001); });
        // The honest time of the last known state: the machine's last heartbeat, said only while it is unreachable.
        expect(hook.getCurrent()).toEqual({ machineReachable: false, machineOnline: false,
            machineRpcTargetAvailable: false, machineReachability: 'unreachable', machineLastSeenAt: lastHeartbeat });
        const refreshed = { ...getStorage().getState().machines.m1!, activeAt: Date.now() };
        await act(async () => getStorage().setState({ machines: { m1: refreshed }, machineListByServerId: { [serverId]: [refreshed] } }));
        expect(hook.getCurrent()).toEqual({ machineReachable: true, machineOnline: true,
            machineRpcTargetAvailable: true, machineReachability: 'reachable', machineLastSeenAt: null });
        const machine = getStorage().getState().machines.m1!;
        const offline = { ...machine, active: false, activeAt: 1 };
        await act(async () => getStorage().setState({ machines: { m1: offline }, machineListByServerId: { [serverId]: [offline] } }));
        expect(hook.getCurrent()).toEqual({ machineReachable: false, machineOnline: false,
            machineRpcTargetAvailable: false, machineReachability: 'unreachable', machineLastSeenAt: 1 });
    });

    it('does not update visible reachability when an unrelated background session changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineOnline).toBe(true));
        const settledUpdates = seen.length;
        await act(async () => getStorage().setState({ sessions: { ...getStorage().getState().sessions,
            background: createSessionFixture({ id: 'background', serverId, active: true, metadata: { machineId: 'm1', path: '/other-repo', host: 'host-1' } }) } }));
        expect(seen).toHaveLength(settledUpdates);
    });

    it('does not update visible reachability when only the machine heartbeat changes', async () => {
        const seen: Array<ReturnType<typeof useSessionMachineReachability>> = [];
        const hook = await renderHook(() => {
            const value = useSessionMachineReachability('s1', serverId);
            React.useEffect(() => { seen.push(value); }, [value]);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().machineOnline).toBe(true));
        const settledUpdates = seen.length;
        const machine = getStorage().getState().machines.m1!;
        const heartbeat = { ...machine, activeAt: machine.activeAt + 1 };
        await act(async () => getStorage().setState({ machines: { m1: heartbeat }, machineListByServerId: { [serverId]: [heartbeat] } }));
        expect(seen).toHaveLength(settledUpdates);
    });
});
