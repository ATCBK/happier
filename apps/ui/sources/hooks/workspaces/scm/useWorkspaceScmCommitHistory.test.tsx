import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmLogEntrySchema } from '@happier-dev/protocol/scm';
import { renderHook, standardCleanup } from '@/dev/testkit';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

const entry = ScmLogEntrySchema.parse({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'A',
    authorEmail: 'a@example.test', timestamp: 1, subject: 'Scoped history', body: '' });

describe('useWorkspaceScmCommitHistory', () => {
    beforeEach(() => rpc.mockReset().mockResolvedValue({ success: true, entries: [entry] }));
    afterEach(() => standardCleanup());
    it('loads the captured workspace history through the real facade and strict response reader', async () => {
        const { useWorkspaceScmCommitHistory } = await import('./useWorkspaceScmCommitHistory');
        const hook = await renderHook(() => useWorkspaceScmCommitHistory({
            serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo', readLogEnabled: true,
        }));
        await act(async () => { await hook.getCurrent().loadCommitHistory({ reset: true }); });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-a', machineId: 'machine-a', method: RPC_METHODS.SCM_LOG_LIST,
            payload: expect.objectContaining({ cwd: '/repo', limit: 50, skip: 0 }),
        }));
        expect(hook.getCurrent()).toMatchObject({ historyEntries: [entry], historyLoading: false, historyHasMore: false });
    });
});
