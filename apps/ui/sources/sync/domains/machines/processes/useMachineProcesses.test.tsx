import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

// The machine RPC connection is the network boundary. Hooks, credential lifetimes and store remain real.
const network = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: network.execute }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineProcessesStore } = await import('./machineProcessesStore');
const { useMachineProcesses } = await import('./useMachineProcesses');
const beforeState = storage.getState();
beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => {
    standardCleanup(); machineProcessesStore.reset(); network.execute.mockReset();
    storage.setState(beforeState); await homes.reset();
});
it('pauses an inactive panel without erasing its rows and aborts its parked network demand', async () => {
    const serverId = await homes.addHome({ name: 'Processes', serverUrl: 'http://process-hook.test', accountId: 'a', currentAccount: true });
    const machine = createMachineFixture({ id: 'm', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
    storage.setState({ profileScope: { serverId, accountId: 'a' }, machineListByServerId: { [serverId]: [machine] } });
    const signals: AbortSignal[] = [];
    network.execute.mockImplementation(async (input: { method: string; signal: AbortSignal }) => {
        if (input.method === RPC_METHODS.DAEMON_PROCESSES_WATCH) {
            signals.push(input.signal);
            return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ changed: false }), { once: true }));
        }
        return { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
    });
    const hook = await renderHook(({ active }: { active: boolean }) => useMachineProcesses({ serverId, machineId: 'm', scope: 'happier', view: 'tree', active }), { initialProps: { active: false } });
    await act(async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); });
    expect(network.execute).not.toHaveBeenCalled();
    await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, daemonStateVersion: 2 }] } }); });
    expect(network.execute).not.toHaveBeenCalled();
    await hook.rerender({ active: true });
    await act(async () => {
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        await vi.waitFor(() => expect(signals).toHaveLength(1));
    });
    expect(network.execute.mock.calls[0][0]).toMatchObject({ serverId, accountId: 'a' });
    const rows = hook.getCurrent().answer;
    await hook.rerender({ active: false });
    expect(signals[0].aborted).toBe(true);
    expect(hook.getCurrent().answer).toBe(rows);
    expect(hook.getCurrent().paused).toBe(true);
    const calls = network.execute.mock.calls.length;
    await hook.rerender({ active: false });
    expect(network.execute.mock.calls).toHaveLength(calls);
    await hook.unmount();
});

it('reports an offline empty read as unavailable and resumes without losing the last good answer', async () => {
    const serverId = await homes.addHome({ name: 'Offline processes', serverUrl: 'http://process-offline-hook.test', accountId: 'a', currentAccount: true });
    storage.setState({ profileScope: { serverId, accountId: 'a' } });
    const machine = createMachineFixture({ id: 'm', active: false, activeAt: 1 });
    await publishMachineInventoryForTest({ serverId, accountId: 'a' }, [machine]);
    network.execute.mockImplementation(async (input: { method: string; signal: AbortSignal }) => {
        if (input.method === RPC_METHODS.DAEMON_PROCESSES_WATCH) {
            return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ changed: false }), { once: true }));
        }
        return { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
    });
    const hook = await renderHook(({ online }: { online: boolean }) => useMachineProcesses({ serverId, machineId: 'm', scope: 'happier', view: 'tree', online }), { initialProps: { online: false } });
    expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', answer: null });
    expect(network.execute).not.toHaveBeenCalled();
    await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'a' }, [{ ...machine, active: true, activeAt: Date.now() }]); });
    await hook.rerender({ online: true });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready')); });
    const answer = hook.getCurrent().answer;
    await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'a' }, [machine]); });
    await hook.rerender({ online: false });
    expect(hook.getCurrent().answer).toBe(answer);
    expect(hook.getCurrent().paused).toBe(true);
    await hook.unmount();
});

it.each(['transport', 'native', 'watch'] as const)('recovers a mounted %s failure on a new daemon publication without interrupting a healthy watch', async failure => {
    const serverId = await homes.addHome({ name: 'Process recovery', serverUrl: 'https://process-recovery.test', accountId: 'a', currentAccount: true });
    const machine = createMachineFixture({ id: 'm', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const answer = { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
        totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
    let failing = true;
    const watches: AbortSignal[] = [];
    network.execute.mockImplementation(async (input: { method: string; signal: AbortSignal }) => {
        if (input.method === RPC_METHODS.DAEMON_PROCESSES_WATCH) {
            if (failing && failure === 'watch') throw new Error('Machine transport disconnected');
            watches.push(input.signal);
            return new Promise(resolve => input.signal.addEventListener('abort', () => resolve({ changed: false }), { once: true }));
        }
        if (failing && failure === 'transport') throw new Error('Machine transport disconnected');
        if (failing && failure === 'native') return { ...answer, state: 'unavailable', reason: 'read_failed' };
        return answer;
    });
    const hook = await renderHook(() => useMachineProcesses({ serverId, machineId: 'm', scope: 'happier', view: 'tree', online: true }));
    try {
        await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe(failure === 'native' ? 'unavailable' : 'error')); });
        if (failure === 'watch') expect(hook.getCurrent().answer?.state).toBe('live');
        const failedReads = network.execute.mock.calls.length;
        failing = false;
        // A normal Machine store update with the same publication does not silently retry.
        await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, activeAt: machine.activeAt + 1 }] } }); });
        expect(network.execute).toHaveBeenCalledTimes(failedReads);
        // The daemon's own new publication establishes recovery without navigating away or clicking Retry.
        await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, daemonStateVersion: 2 }] } }); });
        await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready')); });
        expect(hook.getCurrent().answer?.state).toBe('live');
        const healthyReads = network.execute.mock.calls.length;
        const watch = watches.at(-1);
        expect(watch?.aborted).toBe(false);
        await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, daemonStateVersion: 3 }] } }); });
        expect(network.execute).toHaveBeenCalledTimes(healthyReads);
        expect(watch?.aborted).toBe(false);
    } finally {
        await hook.unmount();
    }
});
