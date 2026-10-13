import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
function Wrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: routerReplace } }).module);

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

const workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

describe('useProjectSurfaceController', () => {
    beforeEach(() => {
        routerReplace.mockClear();
    });

    it('preserves a non-worktree active root path when changing cockpit surfaces on phone', async () => {
        const { useProjectSurfaceController } = await import('./useProjectSurfaceController');
        const hook = await renderHook(() => ({ controller: useProjectSurfaceController({
            scopeId: 'project:wr_1',
            workspaceRef,
            activeRootPath: '/repo/packages/ui',
            activeWorktreeId: null,
        }), pane: useAppPaneScope('project:wr_1') }), { wrapper: Wrapper });

        await act(async () => hook.getCurrent().controller.setActiveTab('services'));
        expect(hook.getCurrent().pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'services' });

        expect(routerReplace).toHaveBeenCalledWith(
            '/projects/wr_1/overview?activeRootPath=%2Frepo%2Fpackages%2Fui&serverId=server-1&mobileSurface=services',
        );

        await hook.unmount();
    });
});
