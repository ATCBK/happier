import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

const routerPush = vi.hoisted(() => vi.fn());
const workspaceRefs: { current: WorkspaceRefV1[] } = { current: [] };
let serverIdA: string;
let serverIdB: string;
let rows: ProjectAccountRowV1[];
let revision: number;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => dimensions, Dimensions: { get: () => dimensions },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Snapshot fetching is a daemon/network boundary; the header and SCM controller stay real.
vi.mock('@/sync/ops/scm/machineScm', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/scm/machineScm')>(),
    machineScmStatusSnapshot: async () => ({ success: false, error: 'Unavailable in this test' }),
}));
const { storage } = await import('@/sync/domains/state/storage');
const { useOpenProject } = await import('./useOpenProject');
const { useWorkspaceRefById, useWorkspaceRefResolutionById } = await import('./detail/useWorkspaceRefById');
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { buildRealmQualifiedMobileSurfaceStorageKey } = await import('@/sync/domains/settings/mobileSurfacePersistence');

function PaneWrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }

async function refreshWorkspaceRefs() {
    const next = workspaceRefs.current.map(ref => {
        const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
        const { lastOpenedAtMs: _recency, ...value } = ref;
        return { key, revision: ++revision, content: { t: 'plain' as const, v: { key, value } } };
    });
    const keys = new Set(next.map(row => buildProjectAccountRowPhysicalKeyV1(row.key)));
    rows = [...next, ...rows.filter(row => !keys.has(buildProjectAccountRowPhysicalKeyV1(row.key)))
        .map(row => ({ ...row, revision: ++revision, content: null }))];
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const census = await createDefaultActionExecutor().execute('projects.list', { serverId: serverIdA });
    expect(census, JSON.stringify(census)).toMatchObject({ ok: true });
    expect(storage.getState().projectAccountRows?.workspaceRefs, JSON.stringify({ census, profileScope: storage.getState().profileScope,
        snapshot: storage.getState().projectAccountRows })).toHaveLength(workspaceRefs.current.length);
}

describe('useOpenProject', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests(); await homes.reset();
        routerPush.mockReset();
        serverIdA = await homes.addHome({ name: 'Projects Home A', serverUrl: 'https://projects-open-a.test', accountId: 'account-a' });
        serverIdB = await homes.addHome({ name: 'Projects Home B', serverUrl: 'https://projects-open-b.test', accountId: 'account-a', active: false });
        rows = []; revision = 0;
        workspaceRefs.current = [{ id: 'wr_1', serverId: serverIdA, machineId: 'machine-a', rootPath: '/repo', label: null, createdAtMs: 1 }];
        homes.answer(serverIdA, 'POST /v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows } }) });
        homes.answer(serverIdA, '/v2/cursor', { body: { cursor: '0' } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-open-a.test')!.token! });
        storage.getState().activateProjectAccountRowsScope({ serverId: serverIdA, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        storage.getState().applyLocalSettings({ projectLastActiveRootPathByWorkspaceRefId: {}, projectLastActiveWorktreeIdByWorkspaceRefId: {},
            projectLastMobileSurfaceByWorkspaceRefId: {} });
        await refreshWorkspaceRefs();
        homes.requests.length = 0;
    });
    afterEach(async () => {
        await standardCleanup();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection(); await homes.reset();
    });

    it('exposes only an accepted checkout of the captured Project to its surfaces', async () => {
        const { useProjectSurfaceController } = await import('./detail/useProjectSurfaceController');
        const base = { ...workspaceRefs.current[0]!, projectKey: 'wr_1' };
        const accepted = { ...base, id: 'accepted-checkout', rootPath: '/repo/accepted' };
        const unrelated = { ...base, id: 'other-project-checkout', rootPath: '/repo/other', projectKey: 'other-project' };
        workspaceRefs.current = [base, accepted, unrelated];
        await refreshWorkspaceRefs();
        const hook = await renderHook((activeRootPath: string) => useProjectSurfaceController({ scopeId: 'captured-project-pane',
            workspaceRef: base, activeRootPath }), { initialProps: accepted.rootPath, wrapper: PaneWrapper });
        expect(hook.getCurrent().checkoutWorkspace).toMatchObject({ serverId: serverIdA, workspaceId: accepted.id, rootPath: accepted.rootPath });
        await hook.rerender(unrelated.rootPath);
        expect(hook.getCurrent().checkoutWorkspace).toBeNull();
        await hook.unmount();
    });

    it('refuses a stale same-Home checkout selected from the Project header after its accepted row is deleted', async () => {
        const { useProjectShellCheckout } = await import('./shell/ProjectShellHeaderHost');
        const current = workspaceRefs.current[0]!;
        const elsewhere = { ...current, id: 'wr_elsewhere', machineId: 'machine-b', rootPath: '/elsewhere' };
        workspaceRefs.current.push(elsewhere);
        await refreshWorkspaceRefs();
        const onSelectWorkspace = vi.fn();
        const hook = await renderHook(() => useProjectShellCheckout({ workspaceRef: current, activeRootPath: current.rootPath,
            onSelectRootPath: () => undefined, onSelectWorkspace }), { wrapper: PaneWrapper });
        hook.getCurrent().checkout.onSelect('ref:wr_elsewhere');
        expect(onSelectWorkspace).toHaveBeenCalledWith(elsewhere);
        onSelectWorkspace.mockClear();
        workspaceRefs.current = [current];
        await act(async () => { await refreshWorkspaceRefs(); });
        hook.getCurrent().checkout.onSelect('ref:wr_elsewhere');
        expect(onSelectWorkspace).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('refuses a duplicate ID across Homes instead of opening the first checkout', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        const hook = await renderHook(() => ({ open: useOpenProject(), ref: useWorkspaceRefById('wr_1') }), { wrapper: PaneWrapper });
        expect(await hook.getCurrent().open('wr_1')).toBe(false);
        expect(hook.getCurrent().open.resolution).toMatchObject({ kind: 'ambiguous', candidates: [
            { serverId: serverIdA, id: 'wr_1' }, { serverId: serverIdB, id: 'wr_1' },
        ] });
        expect(hook.getCurrent().ref).toBeNull();
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('recovers focus from the mounted Open screen at the accepted directory without replaying Open', async () => {
        const { ProjectOpenScreen } = await import('./activation/ProjectOpenScreen');
        const { writeProjectOpenDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const draftId = '00000000-0000-4000-8000-000000000081';
        const accepted = { kind: 'opened' as const, workspace: { serverId: serverIdA, machineId: 'machine-a',
            workspaceId: 'wr_1', rootPath: '/repo' }, directory: '/repo/packages/app', setup: 'approvalRequired' as const };
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        storage.getState().applyLocalSettings({ projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/elsewhere' } });
        writeProjectOpenDraft({ scope: { serverId: serverIdA, accountId: 'account-a' }, draftId,
            patch: { selection: { serverId: serverIdA, machineId: 'machine-a', source: { kind: 'folder', path: '/repo' },
                materialization: { kind: 'attach' } }, result: accepted }, materializationIntent: 'seeded' });
        const screen = await renderScreen(React.createElement(ProjectOpenScreen, { routeParams: { draftId } }), { wrapper: PaneWrapper });
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.submit')).not.toBeNull());
        homes.answer(serverIdA, 'POST /v1/account/project-rows/list', { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('projects.open.submit');
        await vi.waitFor(() => expect(screen.findByTestId('projects.open.acceptedUnfocused')).not.toBeNull());
        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.findByTestId('projects.open.acceptedUnfocused.action')).not.toBeNull();
        homes.answer(serverIdA, 'POST /v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows } }) });
        homes.requests.length = 0;
        await screen.pressByTestIdAsync('projects.open.acceptedUnfocused.action');
        await vi.waitFor(() => expect(routerPush).toHaveBeenCalledOnce());
        const href = new URL(routerPush.mock.calls[0]![0], 'https://happier.invalid');
        expect(href.searchParams.get('serverId')).toBe(serverIdA);
        expect(href.searchParams.get('activeRootPath')).toBe(accepted.directory);
        expect(homes.requests.every(request => !request.path.includes('/actions/') && !request.path.includes('/rpc/'))).toBe(true);
        await screen.unmount();
    });

    it('exposes deep-link ambiguity without staging resource or navigation state, and distinguishes missing and invalid', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        const hook = await renderHook(() => ({ open: useOpenProject(), resolution: useWorkspaceRefResolutionById('wr_1'),
            pane: useAppPaneContext() }), { wrapper: PaneWrapper });
        expect(hook.getCurrent().resolution).toMatchObject({ kind: 'ambiguous', candidates: workspaceRefs.current });
        expect(await hook.getCurrent().open('wr_1', { initialResource: { kind: 'file', path: 'README.md' } })).toBe(false);
        expect(hook.getCurrent().pane.state.scopes).toEqual({});
        expect(routerPush).not.toHaveBeenCalled();
        expect(await hook.getCurrent().open('missing')).toBe(false);
        expect(hook.getCurrent().open.resolution).toEqual({ kind: 'missing' });
        expect(await hook.getCurrent().open('')).toBe(false);
        expect(hook.getCurrent().open.resolution).toMatchObject({ kind: 'invalid' });
    });

    it('keeps a deep-linked checkout unconfirmed, not missing, while the Project rows have not loaded or failed', async () => {
        const scope = { serverId: serverIdA, accountId: 'account-a' };
        const hook = await renderHook(() => useWorkspaceRefResolutionById('wr_1'));
        expect(hook.getCurrent()).toMatchObject({ kind: 'resolved' });
        // A fresh device (or a retired scope) starts from an empty idle census: nothing is known yet.
        await act(async () => {
            storage.getState().clearProjectAccountRowsScope();
            storage.getState().activateProjectAccountRowsScope(scope);
        });
        expect(hook.getCurrent()).toEqual({ kind: 'unconfirmed', status: 'idle' });
        // The read failed: still not "isn't saved here anymore".
        await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(scope, 'error'); });
        expect(hook.getCurrent()).toEqual({ kind: 'unconfirmed', status: 'error' });
        // A complete authorized read that lists it resolves it again; one that does not says it is gone.
        await act(async () => { await refreshWorkspaceRefs(); });
        expect(hook.getCurrent()).toMatchObject({ kind: 'resolved' });
        workspaceRefs.current = [];
        await act(async () => { await refreshWorkspaceRefs(); });
        expect(hook.getCurrent()).toEqual({ kind: 'missing' });
        await hook.unmount();
    });

    it('carries an explicitly selected Home through the project route', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        const hook = await renderHook(() => useOpenProject(), { wrapper: PaneWrapper });
        expect(await hook.getCurrent()('wr_1', { serverId: serverIdB })).toBe(true);
        const href = new URL(routerPush.mock.calls[0][0], 'https://happier.invalid');
        expect(href.pathname).toBe('/projects/wr_1/overview');
        expect(Object.fromEntries(href.searchParams)).toMatchObject({ serverId: serverIdB, worktreeId: '@root' });
    });

    it('never restores a bare-id checkout preference when another Home owns the same id', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        storage.getState().applyLocalSettings({ projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/feature' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'foreign-worktree' } });
        const hook = await renderHook(() => useOpenProject(), { wrapper: PaneWrapper });
        expect(await hook.getCurrent()('wr_1', { serverId: serverIdB })).toBe(true);
        expect(new URL(routerPush.mock.calls[0][0], 'https://happier.invalid').searchParams.get('worktreeId')).toBe('@root');
    });

    it('restores a canonical page only from the selected Home and applied Account realm', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        const key = buildRealmQualifiedMobileSurfaceStorageKey('project', { serverId: serverIdA, accountId: 'account-a' }, 'wr_1')!;
        storage.getState().applyLocalSettings({ projectLastMobileSurfaceByWorkspaceRefId: { [key]: 'context', wr_1: 'git' } });
        const hook = await renderHook(() => useOpenProject(), { wrapper: PaneWrapper });
        expect(await hook.getCurrent()('wr_1', { serverId: serverIdA })).toBe(true);
        expect(new URL(routerPush.mock.calls[0][0], 'https://happier.invalid').pathname).toBe('/projects/wr_1/context');
        expect(await hook.getCurrent()('wr_1', { serverId: serverIdB })).toBe(true);
        expect(new URL(routerPush.mock.calls[1][0], 'https://happier.invalid').pathname).toBe('/projects/wr_1/overview');
    });

    it('restores the selected Home qualified preference despite duplicate bare ids', async () => {
        workspaceRefs.current.push({ ...workspaceRefs.current[0]!, serverId: serverIdB, rootPath: '/other' });
        await refreshWorkspaceRefs();
        const key = `project-selection:v1:${JSON.stringify([serverIdB, 'wr_1'])}`;
        storage.getState().applyLocalSettings({ projectLastActiveRootPathByWorkspaceRefId: { [key]: '/other/feature', wr_1: '/repo/feature' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { [key]: 'selected-worktree', wr_1: 'foreign-worktree' } });
        const hook = await renderHook(() => useOpenProject(), { wrapper: PaneWrapper });
        expect(await hook.getCurrent()('wr_1', { serverId: serverIdB })).toBe(true);
        expect(new URL(routerPush.mock.calls[0][0], 'https://happier.invalid').searchParams.get('worktreeId')).toBe('selected-worktree');
    });

    it('refuses a file open without the mounted Workspace owner instead of falling back to the router', async () => {
        const hook = await renderHook(() => ({ open: useOpenProject(), pane: useAppPaneContext() }), { wrapper: PaneWrapper });

        expect(await hook.getCurrent().open('wr_1', {
            activeRootPath: '/repo',
            initialResource: { kind: 'file', path: 'src/index.ts' },
        })).toBe(false);
        expect(hook.getCurrent().pane.state.scopes).toEqual({});
        expect(routerPush).not.toHaveBeenCalled();
    });
});
