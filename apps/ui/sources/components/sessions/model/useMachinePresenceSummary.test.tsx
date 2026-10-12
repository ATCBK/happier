import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import {
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
} from '@/sync/domains/machines/reachability/machineReachability';
import { useMachinePresenceSummary } from './useMachinePresenceSummary';

afterEach(() => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
    vi.useRealTimers();
});

describe('reactive Machine presence', () => {
    it('expires without another store notification and recovers on a heartbeat, while unknown is not offline', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: 'home' });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary('home', 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');
            const admitted = hook.getCurrent();
            await act(async () => {
                vi.advanceTimersByTime(20_000);
                const heartbeat = { ...machine, activeAt: Date.now() };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: 'home' });
            });
            expect(hook.getCurrent()).toBe(admitted);
            await act(async () => { vi.advanceTimersByTime(40_001); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { vi.advanceTimersByTime(20_000); });
            expect(hook.getCurrent().reachability).toBe('unreachable');
            const refreshed = { ...machine, activeAt: Date.now() };
            await act(async () => { storage.getState().applyMachines([refreshed], false, { sourceServerId: 'home' }); });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await act(async () => { storage.getState().applyMachines([], true, { sourceServerId: 'home' }); });
            expect(hook.getCurrent().reachability).toBe('unknown');
            await hook.unmount();
        } finally { storage.setState(previous); }
    });

    it('keeps a present machine unreachable after a heartbeat until a request succeeds', async () => {
        const now = Date.now();
        const previous = storage.getState();
        const machine = createMachineFixture({ id: 'machine', activeAt: now });
        storage.getState().applyMachines([machine], true, { sourceServerId: 'home' });
        try {
            const hook = await renderHook(() => useMachinePresenceSummary('home', 'machine'));
            expect(hook.getCurrent().reachability).toBe('reachable');

            await act(async () => {
                recordMachineRequestFailed({ serverId: 'home', machineId: 'machine', observedAtMs: now + 1 });
            });
            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                const heartbeat = { ...machine, activeAt: now + 2 };
                storage.getState().applyMachines([heartbeat], false, { sourceServerId: 'home' });
            });
            expect(hook.getCurrent().reachability).toBe('unreachable');

            await act(async () => {
                recordMachineRequestSucceeded({ serverId: 'home', machineId: 'machine', observedAtMs: now + 3 });
            });
            expect(hook.getCurrent().reachability).toBe('reachable');
            await hook.unmount();
        } finally {
            storage.setState(previous);
        }
    });
});
