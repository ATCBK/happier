import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const device = vi.hoisted(() => ({ phone: false }));
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
installSessionDetailsPanelNonRnModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/projects/wr_1/code', router: { replace: router.replace } }).module;
    },
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: device.phone ? 390 : 1440, height: device.phone ? 844 : 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1' });
let restoreWebGlobals: (() => void) | undefined;
beforeEach(() => { device.phone = false; router.replace.mockClear(); restoreWebGlobals = withPopoverWebGlobals(); });
afterEach(() => { restoreWebGlobals?.(); restoreWebGlobals = undefined; });
function workspaceRef(): WorkspaceRefV1 {
    return { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 };
}
async function renderPanel(props: Partial<React.ComponentProps<typeof import('./ProjectRightPanel')['ProjectRightPanel']>> = {}) {
    const { ProjectRightPanel } = await import('./ProjectRightPanel');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => runtime.pane.openRight({ tabId: 'git' }));
    await act(async () => screen.update(<runtime.Wrapper><DestinationInstanceHost tabId="project-right-panel"
        ref={{ kind: 'project', params: { workspaceRefId: 'wr_1', serverId: runtime.serverId } }}
        pathname="/projects/wr_1/code" focused visible
        navigation={{ push: () => {}, replace: router.replace, back: () => {}, setParams: () => {} }}>
        <ProjectRightPanel workspaceRef={workspaceRef()} scopeId="project:wr_1" activeRootPath="/repo"
            onSelectRootPath={() => {}} {...props} />
    </DestinationInstanceHost></runtime.Wrapper>));
    await flushHookEffects({ cycles: 30 });
    return screen;
}
describe('ProjectRightPanel', () => {
    it('renders the canonical Git surface without a close affordance when the parent supplies none', async () => {
        const { ProjectGitSurface } = await import('./surfaces/ProjectGitSurface');
        const screen = await renderPanel();
        expect(screen.tree.findAllByType(ProjectGitSurface)).toHaveLength(1);
        expect(screen.findHostByTestId('project-rightpanel-header')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('selects Files in the real pane and navigates to the sibling root-worktree mobile route', async () => {
        device.phone = true;
        const screen = await renderPanel({ activeWorktreeId: null, onRequestClose: () => {} });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith(`/projects/wr_1/code?serverId=${encodeURIComponent(runtime.serverId)}&worktreeId=%40root&mobileSurface=browse`);
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('says an unreachable checkout at the top of the pane, beside the page (desktop) and over it (phone)', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
        const lastHeartbeat = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: false,
                activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
            const lines = async () => (await renderPanel({ onRequestClose: () => {} })).tree.findAllByType(SurfaceFreshnessLine)
                .map(line => line.props.testID);
            // The page's line spans only its own column: a pane beside it would otherwise sit blank under its header.
            expect(await lines()).toEqual(['project-rightpanel-reachability']);
            device.phone = true;
            expect(await lines()).toEqual(['project-rightpanel-reachability']);
        } finally { vi.useRealTimers(); }
    });
    it('preserves the selected worktree in the sibling mobile route and pane selection', async () => {
        device.phone = true;
        const screen = await renderPanel({
            activeRootPath: '/repo/.worktrees/feature-auth', activeWorktreeId: 'gitwt_feature', onRequestClose: () => {},
        });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith(`/projects/wr_1/code?serverId=${encodeURIComponent(runtime.serverId)}&worktreeId=gitwt_feature&mobileSurface=browse`);
    });
});
