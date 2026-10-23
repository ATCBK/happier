import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), launcher: vi.fn() }));
// Only the transport is replaced; daemon publication, parked watches and UI stores stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

import { createLocalServiceInventoryRegistry } from '../../../../../../../cli/src/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '../../../../../../../cli/src/daemon/local/services/inventory/routes';
import { resetLocalServiceInventoryStoreForTests } from '../inventory/sharedStore';
import { resetLocalServiceLauncherStoreForTests, subscribeLocalServiceLauncherStore } from './sharedStore';

afterEach(() => {
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
});

it('does not invalidate launcher snapshots for 75 unchanged daemon scans, but wakes for a material change', async () => {
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 1_000,
        refreshState: 'idle', entries: [], diagnostics: [] });
    const routes = createLocalServiceInventoryRoutes({ registry });
    const cancellation = new AbortController();
    rpc.machine.mockImplementation(async (request: { method: string; payload: { sinceGeneratedAt?: number } }) => {
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
            return { protocolVersion: 1, ...await routes.watchSnapshot({ ...request.payload, signal: cancellation.signal }) };
        }
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
            return { protocolVersion: 1, snapshot: registry.getSnapshot() };
        }
        return rpc.launcher(request);
    });
    rpc.launcher.mockResolvedValue({ protocolVersion: 1,
        snapshot: LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId: 'machine-a', updatedAt: 1_000, targets: [] }) });
    const release = subscribeLocalServiceLauncherStore({ machineId: 'machine-a', serverId: 'server-a' }, () => {});
    try {
        await vi.waitFor(() => expect(routes.watcherCount()).toBe(1));
        await flushHookEffects();
        const initialReads = rpc.launcher.mock.calls.length;
        for (let index = 1; index <= 75; index++) {
            registry.replaceSnapshot({ ...registry.getSnapshot(), generatedAt: 1_000 + index * 10_000 });
            await flushHookEffects();
        }
        expect(rpc.launcher.mock.calls.length - initialReads).toBe(0);
        registry.replaceSnapshot({ ...registry.getSnapshot(), generatedAt: 761_000,
            diagnostics: [{ code: 'local_services_process_facts_unavailable', severity: 'warning' }] });
        await vi.waitFor(() => expect(rpc.launcher.mock.calls.length - initialReads).toBe(1));
    } finally { release(); cancellation.abort(); }
});
