import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

const boundary = vi.hoisted(() => ({ sequence: 10, push: vi.fn() }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push } }).module;
});
// The modal presentation is the boundary: on a computer Open is the dialog over the current page.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// IndexedDB is supplied by the canonical runtime harness; draft and pane owners stay real.
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(boundary.sequence++).padStart(12, '0')}` }));
const runtime = installSessionPaneRuntimeTestHarness();
// Install Home boundaries before consumers that reach the Sync singleton.
const [{ AppPaneProvider }, { useAppPaneScope }, { useProjectSurfaceActions },
    { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests }, { prepareSessionDraftPersistenceStorage }] = await Promise.all([
    import('@/components/appShell/panes/AppPaneProvider'),
    import('@/components/appShell/panes/hooks/useAppPaneScope'),
    import('./useProjectSurfaceActions'),
    import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
    import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage'),
]);
function Wrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }

describe('useProjectSurfaceActions', () => {
    beforeEach(async () => {
        standardCleanup(); boundary.push.mockReset(); resetSessionDraftRepositoryForTests();
        await prepareSessionDraftPersistenceStorage();
    });
    it('opens Changes in the companion without creating a separate Details tab', async () => {
        const scopeId = 'project:review';
        const workspaceRef = { id: 'review', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo', createdAtMs: 1 };
        const hook = await renderHook(() => ({ pane: useAppPaneScope(scopeId),
            actions: useProjectSurfaceActions({ scopeId, workspaceRef, activeRootPath: '/repo' }),
        }), { wrapper: Wrapper });
        try {
            await act(async () => hook.getCurrent().actions.openReviewAllChanges());
            expect(hook.getCurrent().pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
            expect(hook.getCurrent().pane.scopeState?.details.tabs).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('reveals in Files and returns to Changes while retaining unsent Details and commit drafts', async () => {
        const scopeId = 'project:files';
        const workspaceRef = { id: 'files', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo', createdAtMs: 1 };
        const hook = await renderHook(() => ({ pane: useAppPaneScope(scopeId),
            actions: useProjectSurfaceActions({ scopeId, workspaceRef, activeRootPath: '/repo' }),
        }), { wrapper: Wrapper });
        try {
            await act(async () => hook.getCurrent().pane.setDetailsTabState('file:src/a.ts', { editorText: 'unsaved' }));
            await act(async () => hook.getCurrent().actions.revealInFilesTree('src/a.ts'));
            expect(hook.getCurrent().pane.scopeState?.right.activeTabId).toBe('files');
            expect(hook.getCurrent().pane.scopeState?.right.tabState.files).toMatchObject({ revealRequest: { path: 'src/a.ts' } });
            expect(hook.getCurrent().pane.scopeState?.details.tabState['file:src/a.ts']).toEqual({ editorText: 'unsaved' });
            const openChanges = hook.getCurrent().actions.openChanges;
            await act(async () => hook.getCurrent().pane.setRightTabState('git', { activeSubTabId: 'history', commitMessageDraft: 'keep me' }));
            await act(async () => openChanges());
            expect(hook.getCurrent().pane.scopeState?.right.activeTabId).toBe('git');
            expect(hook.getCurrent().pane.scopeState?.right.tabState.git).toMatchObject({ activeSubTabId: 'commit', commitMessageDraft: 'keep me' });
            expect(hook.getCurrent().pane.scopeState?.details.tabState['file:src/a.ts']).toEqual({ editorText: 'unsaved' });
        } finally { await hook.unmount(); }
    });
    it('retains an agent-free worktree draft with the exact Home, Machine and current folder before navigation', async () => {
        const hook = await renderHook(() => useProjectSurfaceActions({ scopeId: 'project:wr_1',
            workspaceRef: { id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo', createdAtMs: 1 },
            activeRootPath: '/repo/.worktrees/feature-auth' }), { wrapper: Wrapper });
        hook.getCurrent().openCreateWorktreeFlow();
        const { Modal } = await import('@/modal');
        const dialogParams = () => vi.mocked(Modal.show).mock.calls.map(([config]) => config as { chrome?: { testID?: string }; props?: { routeParams?: { draftId: string; serverId: string } } })
            .find(config => config.chrome?.testID === 'projects.open.dialog')?.props?.routeParams;
        await vi.waitFor(() => expect(dialogParams()).toBeDefined());
        expect(boundary.push).not.toHaveBeenCalled();
        const route = { params: dialogParams()! };
        const document = getSessionDraftSnapshot({ serverId: runtime.serverId, accountId: 'account-a' }, { kind: 'projectOpen', draftId: route.params.draftId })?.document;
        expect(document).toMatchObject({ target: { kind: 'projectOpen' }, selection: { value: {
            serverId: runtime.serverId, machineId: 'machine-1', source: { kind: 'folder', path: '/repo/.worktrees/feature-auth' },
            materialization: { kind: 'worktree', checkout: { kind: 'git_worktree', displayName: '', baseRef: null } },
        } } });
        expect(document).not.toHaveProperty('composer');
        await hook.unmount();
    });
});
