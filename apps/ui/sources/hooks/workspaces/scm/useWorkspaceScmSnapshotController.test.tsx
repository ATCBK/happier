import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { useWorkspaceScmSnapshotController } from './useWorkspaceScmSnapshotController';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

const scope = { serverId: 'snapshot-home', machineId: 'snapshot-machine', rootPath: '/snapshot-repo' };
const snapshot = ScmWorkingSnapshotSchema.parse({
    projectKey: 'snapshot-machine:/snapshot-repo', fetchedAt: 1,
    repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{ path: 'src/a.ts', kind: 'modified', previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        includeStatus: '', pendingStatus: 'pending', hasIncludedDelta: false, hasPendingDelta: true }],
    totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0, includedAdded: 0,
        includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0 },
});

describe('useWorkspaceScmSnapshotController', () => {
    beforeEach(() => {
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        rpc.mockReset().mockResolvedValue({ success: true, snapshot });
    });
    it('reads accepted repository facts without a mount probe, while retaining explicit refresh', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, snapshot);
        const hook = await renderHook(() => useWorkspaceScmSnapshotController(scope, { refreshOnMount: false }));
        expect(hook.getCurrent().snapshot).toBe(snapshot);
        expect(rpc).not.toHaveBeenCalled();
        await hook.getCurrent().refresh();
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.SCM_STATUS_SNAPSHOT }));
        await hook.unmount();
    });
    it('refreshes the addressed workspace, publishes status and prunes only its obsolete selections', async () => {
        const state = storage.getState();
        const other = { ...scope, serverId: 'other-home' };
        state.markWorkspaceScmTouchedPaths(scope, ['src/a.ts', 'deleted.ts']);
        state.markWorkspaceScmCommitSelectionPaths(scope, ['src/a.ts', 'deleted.ts']);
        for (const path of ['src/a.ts', 'deleted.ts']) state.upsertWorkspaceScmCommitSelectionPatch(scope, { path, patch: 'retained patch' });
        state.markWorkspaceScmCommitSelectionPaths(other, ['deleted.ts']);
        state.updateWorkspaceScmSnapshotError(scope, { message: 'old error', at: 0 });

        const hook = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        await vi.waitFor(() => expect(hook.getCurrent().snapshot?.entries.map(entry => entry.path)).toEqual(['src/a.ts']));
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: scope.serverId, machineId: scope.machineId, method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: scope.rootPath }),
        }));
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: null, snapshot: { branch: { head: 'main' } } });
        expect(state.getWorkspaceScmSnapshot(scope)?.entries.map(entry => entry.path)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmSnapshotError(scope)).toBeNull();
        expect(state.getWorkspaceScmStatus(scope)).not.toBeNull();
        expect(state.getWorkspaceScmTouchedPaths(scope)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmCommitSelectionPatches(scope).map(patch => patch.path)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmCommitSelectionPaths(other)).toEqual(['deleted.ts']);
        await hook.unmount();
    });
});
