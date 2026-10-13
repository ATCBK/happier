import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const { useWorkspaceFileScmStageActions } = await import('./useWorkspaceFileScmStageActions');
const capabilities = createScmCapabilities({ readStatus: true, writeInclude: true, writeExclude: true, writeCommitLineSelection: true });
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let scope = { serverId: '', machineId: 'machine-1', rootPath: '/stage-repo' };
let sequence = 0;
const snapshot = () => ScmWorkingSnapshotSchema.parse({
    projectKey: 'stage-project', fetchedAt: 1,
    repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
    capabilities, branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{ path: 'src/a.ts', kind: 'modified', previousPath: null, includeStatus: '', pendingStatus: 'M',
        hasIncludedDelta: false, hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }],
    totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0, includedAdded: 0,
        includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1 },
});
const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
function input(overrides: Partial<Parameters<typeof useWorkspaceFileScmStageActions>[0]> = {}) {
    return { scope, filePath: 'src/a.ts', scmSnapshot: snapshot(), scmWriteEnabled: true,
        scmCommitStrategy: 'atomic' as const, includeExcludeEnabled: false,
        diffMode: 'pending' as const, diffContent: null, lineSelectionEnabled: false,
        selectedLineKeys: new Set<string>(), refreshAll: async () => {},
        setSelectedLineKeys: vi.fn(), ...overrides };
}

describe('useWorkspaceFileScmStageActions', () => {
    beforeEach(async () => {
        projectManager.clear();
        home = await serveActionHomes({ homes: [{ key: 'stage', serverUrl: `https://stage-${++sequence}.test`,
            accountId: 'stage-account', currentAccount: true, settings: {
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                    'scm.change.include': ['ui'], 'scm.change.exclude': ['ui'],
                } }),
            } }], route: request => request.path === '/v1/account/encryption/currentness'
                ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : undefined });
        disconnect = await home.restoreActiveConnection();
        scope = { ...scope, serverId: home.homes.stage!.id };
        rpc.mockReset().mockImplementation(async request =>
            request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT ? { success: true, snapshot: snapshot() }
                : request.method === RPC_METHODS.SCM_BACKEND_DESCRIBE ? { success: true, capabilities }
                : { success: true });
    });
    afterEach(async () => {
        await standardCleanup();
        await disconnect?.(); disconnect = undefined;
        await home?.dispose();
    });
    it('marks/unmarks real atomic selection and removes the superseded line patch', async () => {
        storage.getState().upsertWorkspaceScmCommitSelectionPatch(scope, { path: 'src/a.ts', patch: 'old patch' });
        const hook = await renderHook(() => useWorkspaceFileScmStageActions(input()));
        await act(async () => { await hook.getCurrent().handleStage(true); });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['src/a.ts']);
        expect(storage.getState().getWorkspaceScmCommitSelectionPatches(scope)).toEqual([]);
        await act(async () => { await hook.getCurrent().handleStage(false); });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        expect(storage.getState().getWorkspaceScmCommitSelectionPatches(scope)).toEqual([]);
        expect(rpc).not.toHaveBeenCalled();
    });
    it('refuses an invalid atomic line selection without throwing or clearing the selected lines', async () => {
        const request = input({ diffContent: diff, lineSelectionEnabled: true, selectedLineKeys: new Set(['additions:999']) });
        const hook = await renderHook(() => useWorkspaceFileScmStageActions(request));
        let result: unknown;
        let caught: unknown = null;
        try { await act(async () => { result = await hook.getCurrent().applySelectedLines(); }); }
        catch (error) { caught = error; }
        expect(caught).toBeNull();
        expect(result).toBe(false);
        expect(request.setSelectedLineKeys).not.toHaveBeenCalled();
        expect(storage.getState().getWorkspaceScmCommitSelectionPatches(scope)).toEqual([]);
        expect(rpc).not.toHaveBeenCalled();
    });
    it('persists a valid atomic line patch and clears the selection only after accepting it', async () => {
        storage.getState().markWorkspaceScmCommitSelectionPaths(scope, ['src/a.ts']);
        const request = input({ diffContent: diff, lineSelectionEnabled: true, selectedLineKeys: new Set(['additions:1']) });
        const hook = await renderHook(() => useWorkspaceFileScmStageActions(request));
        let result: unknown;
        await act(async () => { result = await hook.getCurrent().applySelectedLines(); });
        expect(result).toBe(true);
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        expect(storage.getState().getWorkspaceScmCommitSelectionPatches(scope)).toEqual([
            expect.objectContaining({ path: 'src/a.ts', patch: expect.stringContaining('+new') }),
        ]);
        expect(request.setSelectedLineKeys).toHaveBeenCalledWith(new Set());
        expect(rpc).not.toHaveBeenCalled();
    });
    it('live-stages through real Action admission and refreshes the same workspace snapshot', async () => {
        const hook = await renderHook(() => useWorkspaceFileScmStageActions(input({
            scmCommitStrategy: 'git_staging', includeExcludeEnabled: true,
        })));
        await act(async () => { await hook.getCurrent().handleStage(true); });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: scope.serverId, machineId: scope.machineId, method: RPC_METHODS.SCM_CHANGE_INCLUDE,
            payload: expect.objectContaining({ cwd: scope.rootPath, paths: ['src/a.ts'] }),
        }));
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: scope.serverId, machineId: scope.machineId, method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: scope.rootPath }),
        }));
        expect(storage.getState().getWorkspaceScmSnapshot(scope)?.entries.map(entry => entry.path)).toEqual(['src/a.ts']);
        expect(storage.getState().getWorkspaceScmOperationLog(scope).at(-1)).toMatchObject({ operation: 'stage', status: 'success' });
        expect(storage.getState().getWorkspaceScmInFlightOperation(scope)).toBeNull();
        expect(hook.getCurrent().isApplyingStage).toBe(false);
    });
});
