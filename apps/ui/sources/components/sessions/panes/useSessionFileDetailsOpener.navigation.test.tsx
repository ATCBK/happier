import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useSessionFilePaneNavigation } from './useSessionFileDetailsOpener';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 390, height: 844 }) });
});
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'phone' }));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => null, useLocalSettingMutable: () => [null, vi.fn()] });
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scopeId = 'session:s1';
function useNavigation() {
    return { pane: useAppPaneScope(scopeId), navigation: useSessionFilePaneNavigation({ scopeId, sessionId: 's1', serverId: 'server-b' }) };
}
function Wrapper({ children }: React.PropsWithChildren) { return <AppPaneProvider>{children}</AppPaneProvider>; }

describe('session file pane navigation', () => {
    it('retains Files commands across unrelated cockpit changes and follows a replaced surface command', async () => {
        const destinations: string[] = [];
        const switchSurface = (surface: string) => { destinations.push(surface); };
        let navigation = { switchSurface, returnToPreviousSurface: () => {} };
        function CockpitWrapper({ children }: React.PropsWithChildren) {
            return <AppPaneProvider><SessionCockpitSurfaceNavigationProvider value={navigation}>{children}</SessionCockpitSurfaceNavigationProvider></AppPaneProvider>;
        }
        const hook = await renderHook(useNavigation, { wrapper: CockpitWrapper });
        try {
            const openFiles = hook.getCurrent().navigation.openFiles;
            navigation = { switchSurface, returnToPreviousSurface: () => {} };
            await hook.rerender();
            expect(hook.getCurrent().navigation.openFiles).toBe(openFiles);
            await act(async () => { openFiles(); });
            expect(destinations).toEqual(['browse']);
            navigation = { switchSurface: surface => { destinations.push(`current:${surface}`); }, returnToPreviousSurface: () => {} };
            await hook.rerender();
            await act(async () => { hook.getCurrent().navigation.openFiles(); });
            expect(destinations).toEqual(['browse', 'current:browse']);
        } finally { await hook.unmount(); }
    });

    it('keeps the addressed server when opening Files and Changes on a phone', async () => {
        push.mockClear();
        const hook = await renderHook(useNavigation, { wrapper: Wrapper });
        await act(async () => hook.getCurrent().navigation.revealInFilesTree('src/a.ts'));
        expect(push).toHaveBeenLastCalledWith('/session/s1/files?serverId=server-b');
        expect(hook.getCurrent().pane.scopeState?.right.tabState.files).toMatchObject({ revealRequest: { path: 'src/a.ts' } });
        await act(async () => hook.getCurrent().navigation.openChanges());
        expect(push).toHaveBeenLastCalledWith('/session/s1/git?serverId=server-b');
        await hook.unmount();
    });

    it('switches retained cockpit surfaces without pushing another route', async () => {
        push.mockClear();
        const destinations: string[] = [];
        function CockpitWrapper({ children }: React.PropsWithChildren) {
            return <AppPaneProvider><SessionCockpitSurfaceNavigationProvider value={{ switchSurface: surface => destinations.push(surface), returnToPreviousSurface: () => {} }}>{children}</SessionCockpitSurfaceNavigationProvider></AppPaneProvider>;
        }
        const hook = await renderHook(useNavigation, { wrapper: CockpitWrapper });
        await act(async () => hook.getCurrent().navigation.revealInFilesTree('src/a.ts'));
        await act(async () => hook.getCurrent().navigation.openChanges());
        expect(destinations).toEqual(['browse', 'git']);
        expect(push).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
