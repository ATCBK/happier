import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

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
beforeEach(async () => { await loadSyncSingletonForTests(); });
afterEach(async () => {
    standardCleanup(); machineProcessesStore.reset(); network.execute.mockReset();
    storage.setState(beforeState); await homes.reset();
});
it('pauses an inactive panel without erasing its rows and aborts its parked network demand', async () => {
    const serverId = await homes.addHome({ name: 'Processes', serverUrl: 'http://process-hook.test', accountId: 'a', currentAccount: true });
    storage.setState({ profileScope: { serverId, accountId: 'a' } });
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
    await hook.rerender({ active: true });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
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
    await hook.rerender({ online: true });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const answer = hook.getCurrent().answer;
    await hook.rerender({ online: false });
    expect(hook.getCurrent().answer).toBe(answer);
    expect(hook.getCurrent().paused).toBe(true);
    await hook.unmount();
});
