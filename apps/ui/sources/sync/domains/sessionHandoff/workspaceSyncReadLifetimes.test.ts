import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ pending: true, requests: [] as { signal?: AbortSignal }[] }));
// The daemon transport is the boundary; read stores, operation adapters and schemas stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { signal?: AbortSignal; method: string; payload: { relationshipId?: string } }) => {
        boundary.requests.push(input);
        if (boundary.pending) await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort',
            () => reject(new Error('aborted')), { once: true }));
        return input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST ? { statuses: [] } : {
            status: 'page', relationshipId: input.payload.relationshipId, totalCount: 0, nextCursor: null, conflicts: [],
        };
    },
}));
const status = await import('./workspaceSyncStatusStore');
const conflict = await import('./workspaceSyncConflictStore');
afterEach(() => { status.resetWorkspaceSyncStatusStoreForTests(); conflict.resetWorkspaceSyncConflictStoreForTests();
    boundary.pending = true; boundary.requests.length = 0; });

it.each(['statuses', 'conflicts'] as const)('cancels the shared %s read only after its last consumer leaves and admits the next read', async kind => {
    const scope = { serverId: 'home-one', controllerMachineId: 'machine-one', relationshipId: 'relationship-one' };
    const other = kind === 'statuses' ? { ...scope, relationshipId: 'relationship-two' } : scope;
    const subscribe = kind === 'statuses' ? status.subscribeWorkspaceSyncStatus : conflict.subscribeWorkspaceSyncConflicts;
    const read = () => kind === 'statuses' ? status.refreshWorkspaceSyncStatuses([scope, other])
        : conflict.refreshWorkspaceSyncConflicts(scope);
    const first = subscribe(scope, () => {});
    const second = subscribe(other, () => {});
    const pending = read().catch(() => undefined);
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
    first();
    expect(boundary.requests[0]?.signal?.aborted).toBe(false);
    second();
    expect(boundary.requests[0]?.signal?.aborted).toBe(true);
    await pending;
    boundary.pending = false;
    const unsubscribe = subscribe(scope, () => {});
    await read();
    expect(boundary.requests).toHaveLength(2);
    const snapshot = kind === 'statuses' ? status.getWorkspaceSyncStatusSnapshot(scope)
        : conflict.getWorkspaceSyncConflictSnapshot(scope);
    expect(snapshot.phase).toBe('ready');
    unsubscribe();
});
