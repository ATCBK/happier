import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
} from '@/sync/domains/machines/reachability/machineReachability';
const home = createHomeGovernanceHarness();
const serverId = 'srv_presence';
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMachinePresenceSummary, useMachinePresenceMembership } = await import('@/sync/domains/machines/reachability/useMachinePresenceSummary');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Presence Home', serverUrl: 'https://presence.example.test',
        serverIdentityId: serverId, accountId: 'account-a' });
});

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
    vi.useRealTimers();
    await home.reset();
});

describe('reactive Machine presence', () => {
    it('keeps the captured presence snapshot until a source or the shared deadline clock advances', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const now = Date.now();
        vi.setSystemTime(now);
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => ({
                membership: useMachinePresenceMembership(serverId),
                summary: useMachinePresenceSummary(serverId, 'machine'),
            }));
            const captured = hook.getCurrent();
            expect(captured.membership.onlineMachineIds).toEqual(['machine']);
            expect(captured.summary.reachability).toBe('reachable');

            // A delayed renderer can cross a lease deadline between React's two
            // snapshot reads before the subscribed clock callback gets to run.
            vi.setSystemTime(now + 60_001);
            await hook.rerender();
            expect(hook.getCurrent().membership).toBe(captured.membership);
            expect(hook.getCurrent().summary).toBe(captured.summary);

            await act(async () => {
                vi.advanceTimersByTime(60_001);
            });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual([]);
            expect(hook.getCurrent().summary.reachability).toBe('unreachable');

            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().membership.onlineMachineIds).toEqual(['machine']);
            expect(hook.getCurrent().summary.reachability).toBe('reachable');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('keeps locked machines in presence inventory without admitting them to the selectable fleet', async () => {
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'locked-machine', active: true, activeAt: Date.now(),
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceMembership(serverId));
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: ['locked-machine'], selectableMachineIds: [] });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });
    it('keeps app membership stable across presentation and heartbeat changes, but reacts to expiry and request recovery', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useMachinePresenceMembership(serverId);
            });
            const admitted = hook.getCurrent();
            const rendersAfterAdmission = renders;
            expect(admitted).toEqual({ onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now(), metadata: {
                    ...machine.metadata!, displayName: 'Renamed computer',
                } }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toBe(admitted);
            expect(renders).toBe(rendersAfterAdmission);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent()).toBe(admitted);
            expect(renders).toBe(rendersAfterAdmission);

            await act(async () => {
                recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine' });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [] });
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [] });
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [] });
            await act(async () => {
                recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: 'machine' });
            });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: ['machine'], selectableMachineIds: ['machine'] });
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: serverId }); });
            expect(hook.getCurrent()).toEqual({ onlineMachineIds: [], selectableMachineIds: [] });
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('expires without another store notification and recovers on a heartbeat, while unknown is not offline', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary(serverId, 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');
            const admitted = hook.getCurrent();
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                const heartbeat = { ...machine, activeAt: Date.now() };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent()).toBe(admitted);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent().reachability).toBe('unreachable');
            const refreshed = { ...machine, activeAt: Date.now() };
            await act(async () => { storage.getState().applyMachines([refreshed], false, { sourceServerId: serverId }); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: serverId }); });
            expect(hook.getCurrent().reachability).toBe('unknown');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps a present machine unreachable after a heartbeat until a request succeeds', async () => {
        const now = Date.now();
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary(serverId, 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');

            await act(async () => {
                recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine', observedAtMs: now + 1 });
            });

            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                const heartbeat = { ...machine, activeAt: now + 2 };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: serverId });
            });
            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: 'machine', observedAtMs: now + 3 });
            });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await hook.unmount();
        } finally {
            storage.setState(previous);
        }
    });
});
