import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { prompt: async () => { filesystem.prompts += 1; await filesystem.promptGate; return 'b'; },
        confirm: async () => { filesystem.prompts += 1; await filesystem.promptGate; return true; } },
}).module);
const filesystem = vi.hoisted(() => ({ paths: new Set<string>(), calls: [] as unknown[],
    response: { success: true } as unknown, error: null as unknown, prompts: 0, promptGate: null as Promise<void> | null }));
// The machine filesystem is a genuine cross-process boundary; policy, schemas,
// captured Account custody and approval Artifact replay remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async (request: { method: string; payload: { path?: string; from?: string; to?: string } }) => {
        filesystem.calls.push(request);
        if (filesystem.error) throw filesystem.error;
        if (request.method === 'daemon.filesystem.createDirectory' && request.payload.path) filesystem.paths.add(request.payload.path);
        if (request.method === 'daemon.filesystem.rename' && request.payload.from && request.payload.to) {
            filesystem.paths.delete(request.payload.from); filesystem.paths.add(request.payload.to);
        }
        if (request.method === 'daemon.filesystem.delete' && request.payload.path) filesystem.paths.delete(request.payload.path);
        return filesystem.response;
    },
}));
const { storage } = await import('@/sync/domains/state/storage');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { workspaceCreateDirectory } = await import('./directoryBrowsing');
const { workspaceListDirectory, workspaceGetDirectoryTree } = await import('./directoryBrowsing');
const { workspaceWriteFile } = await import('./fileReadWrite');
const { workspaceRenamePath, workspaceDeletePath } = await import('./pathMetadataMutations');
type Target = Parameters<typeof workspaceCreateDirectory>[0];
const operations = [
    { actionId: 'daemon.filesystem.createDirectory' as const, run: (target: Target) => workspaceCreateDirectory(target, 'folder'), after: ['/repo/a', '/repo/folder'] },
    { actionId: 'daemon.filesystem.rename' as const, run: (target: Target) => workspaceRenamePath(target, { from: 'a', to: 'b', overwrite: false }), after: ['/repo/b'] },
    { actionId: 'daemon.filesystem.delete' as const, run: (target: Target) => workspaceDeletePath(target, { path: 'a', recursive: false }), after: [] },
];
let serverId: string;
let target: Target;
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Filesystem Home', serverUrl: 'https://filesystem-action.test', accountId: 'account-a' });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://filesystem-action.test')!.token! });
    target = { serverId, machineId: 'machine-a', rootPath: '/repo' };
    filesystem.paths.clear(); filesystem.paths.add('/repo/a'); filesystem.calls.length = 0;
    filesystem.response = { success: true }; filesystem.error = null;
    filesystem.prompts = 0; filesystem.promptGate = null;
});
afterEach(async () => {
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
});

describe('shared workspace filesystem Action admission', () => {
    it('routes bounded directory reads through the same Action policy choke point', async () => {
        filesystem.response = { success: true, entries: [] };
        expect(await workspaceListDirectory(target, 'src')).toEqual({ success: true, entries: [] });
        filesystem.response = { success: true, tree: { name: 'src', path: '/repo/src', type: 'directory' } };
        expect(await workspaceGetDirectoryTree(target, 'src', 2)).toMatchObject({ success: true, tree: { name: 'src' } });
        expect(filesystem.calls).toEqual([
            expect.objectContaining({ method: 'listDirectory', payload: { rootPath: '/repo', path: '/repo/src' } }),
            expect.objectContaining({ method: 'daemon.filesystem.getDirectoryTree', payload: { rootPath: '/repo', path: '/repo/src', maxDepth: 2 } }),
        ]);
    });

    it('keeps an inline file write behind Ask-first admission and executes the exact rooted bytes only after approval', async () => {
        await homes.requireUiApproval(serverId, 'daemon.filesystem.writeFile');
        const pending = await workspaceWriteFile(target, 'created.txt', 'hello');
        expect(pending).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
        expect(filesystem.calls).toEqual([]);
        if (!('approvalArtifactId' in pending) || typeof pending.approvalArtifactId !== 'string') throw new Error('Expected approval custody');
        filesystem.response = { success: true, hash: 'sha256:inline' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: pending.approvalArtifactId, decision: 'approve',
        }, { surface: 'ui', serverId })).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(filesystem.calls).toEqual([expect.objectContaining({ method: 'daemon.filesystem.writeFile', payload: {
            rootPath: '/repo', path: '/repo/created.txt', content: 'aGVsbG8=',
        } })]);
    });

    it.each(['rename', 'delete'] as const)('retires the real %s prompt before it can borrow a newly signed-in Account', async operation => {
        let release = () => {};
        filesystem.promptGate = new Promise<void>(resolve => { release = resolve; });
        const { useWorkspaceRepositoryTreeRowActions } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions');
        const hook = await renderHook(() => useWorkspaceRepositoryTreeRowActions({
            workspaceScope: { ...target, serverId }, writeActionsEnabled: true,
            expandedPaths: [], onExpandedPathsChange: () => {},
        }));
        await act(async () => {
            const pending = hook.getCurrent().onSelectRowMenuItem({ path: 'a', type: 'file' }, operation === 'rename'
                ? 'repository-tree-menuitem-rename' : 'repository-tree-menuitem-delete');
            await vi.waitFor(() => expect(filesystem.prompts).toBe(1));
            await homes.switchAccount(serverId, 'account-b');
            storage.getState().activateProfileScope({ serverId, accountId: 'account-b' });
            release();
            await pending;
        });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
        await hook.unmount();
    });
    it('preserves literal selected tilde-directory names and explicit rooted choices through admission', async () => {
        await workspaceRenamePath(target, { from: '~/line\nbreak ', to: '~/renamed ' });
        await workspaceDeletePath(target, { path: '~/line\nbreak ', recursive: true });
        await workspaceCreateDirectory(target, '~');
        expect(filesystem.calls).toEqual([
            expect.objectContaining({ method: 'daemon.filesystem.rename', payload: {
                rootPath: '/repo', from: '/repo/~/line\nbreak ', to: '/repo/~/renamed ', overwrite: false,
            } }),
            expect.objectContaining({ method: 'daemon.filesystem.delete', payload: {
                rootPath: '/repo', path: '/repo/~/line\nbreak ', recursive: true,
            } }),
            expect.objectContaining({ method: 'daemon.filesystem.createDirectory', payload: { rootPath: '/repo', path: '/repo/~' } }),
        ]);
    });
    it('preserves a typed missing-method failure from the actual Machine boundary', async () => {
        filesystem.error = Object.assign(new Error('Method not found'), { rpcErrorCode: 'RPC_METHOD_NOT_FOUND' });
        const result = await workspaceCreateDirectory(target, 'folder');
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'RPC_METHOD_NOT_FOUND' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
    });
    it('refuses an invalid Machine response rather than reporting a completed folder', async () => {
        filesystem.response = null;
        const result = await workspaceCreateDirectory(target, 'folder');
        expect(result).toMatchObject({ success: false, error: expect.any(String) });
    });
    it('the real rename control retains pending approval and settles the directory expansion only after execution', async () => {
        await homes.requireUiApproval(serverId, 'daemon.filesystem.rename');
        const { useWorkspaceRepositoryTreeRowActions } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions');
        const alerts = vi.spyOn((await import('@/modal')).Modal, 'alert');
        const approvals: ActionApprovalRegistration[] = [];
        const refresh = vi.fn();
        const expanded = vi.fn();
        const hook = await renderHook(() => useWorkspaceRepositoryTreeRowActions({
            workspaceScope: { ...target, serverId }, writeActionsEnabled: true,
            expandedPaths: ['a', 'a/sub', 'other'], onExpandedPathsChange: expanded, onRequestRefresh: refresh,
            onActionApproval: registration => approvals.push(registration),
        }));
        await act(async () => { await hook.getCurrent().onSelectRowMenuItem({ path: 'a', type: 'directory' }, 'repository-tree-menuitem-rename'); });
        expect(approvals).toHaveLength(1);
        expect(alerts).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(expanded).not.toHaveBeenCalled();
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        const { normalizeActionApprovalRegistration } = await import('@/components/approvals/actionApprovalContinuation');
        const registration = normalizeActionApprovalRegistration(approvals[0]);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: registration.artifactId, decision: 'approve' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect([...filesystem.paths]).toEqual(['/repo/b']);
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureActionAccountContext(serverId);
        try {
            const artifact = await account.fetchArtifact(registration.artifactId);
            if (!artifact) throw new Error('Approval Artifact disappeared');
            await act(async () => { await registration.continuation?.onExecuted(artifact); });
        } finally { account.dispose(); }
        expect(expanded).toHaveBeenCalledWith(['b', 'b/sub', 'other']);
        expect(refresh).toHaveBeenCalledOnce();
        await hook.unmount();
    });
    it.each(operations)('$actionId cannot reach the machine when UI-disabled', async operation => {
        const scope = { serverId, accountId: 'account-a' };
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [operation.actionId]: { disabledSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const result = await operation.run(target);
        expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: 'action_disabled' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
    });

    it.each(operations)('$actionId defers its exact rooted effect until approval', async operation => {
        await homes.requireUiApproval(serverId, operation.actionId);
        const pending = await operation.run(target);
        expect(pending, JSON.stringify(pending)).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
        if (!('approvalArtifactId' in pending) || typeof pending.approvalArtifactId !== 'string') throw new Error('Expected canonical approval custody');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: pending.approvalArtifactId, decision: 'approve',
        }, { surface: 'ui', serverId })).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
        expect(filesystem.calls).toEqual([expect.objectContaining({ serverId, accountId: 'account-a', machineId: 'machine-a',
            method: operation.actionId, payload: expect.objectContaining({ rootPath: '/repo' }) })]);
    });

    it.each(operations)('$actionId keeps the ordinary allowed operation usable', async operation => {
        const result = await operation.run(target);
        expect(result, JSON.stringify(result)).toMatchObject({ success: true });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
    });
});
