import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { useOpenSessionCollaboration } from './useOpenSessionCollaboration';
import { consumeSessionCollaborationIntent, resetSessionCollaborationIntentsForTests } from './sessionCollaborationIntent';

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const preferences = vi.hoisted(() => ({ mobileWorkspaceExperienceV1: 'classic' as 'classic' | 'cockpit' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: route }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSetting: createUseSettingMock({ values: preferences }) });
});

/** The provider is a memo component; the harness wrapper contract wants a plain one. */
function PaneWrapper(props: Readonly<{ children?: React.ReactNode }>) {
    return <AppPaneProvider>{props.children}</AppPaneProvider>;
}

describe('open Session Collaboration', () => {
    beforeEach(() => {
        route.push.mockClear();
        route.replace.mockClear();
        preferences.mobileWorkspaceExperienceV1 = 'classic';
        resetSessionCollaborationIntentsForTests();
    });
    afterEach(standardCleanup);

    it('replaces detached Info with the exact Home root destination in each workspace experience', async () => {
        const hook = await renderHook(() => useOpenSessionCollaboration({
            target: { serverId: 'home-b', sessionId: 'same-id' },
            replace: true,
            focusTarget: 'access',
        }));
        hook.getCurrent()();
        expect(route.replace).toHaveBeenLastCalledWith('/session/same-id?serverId=home-b&collaborationFocus=access&right=collaboration');

        preferences.mobileWorkspaceExperienceV1 = 'cockpit';
        await hook.rerender();
        hook.getCurrent()();
        expect(route.replace).toHaveBeenLastCalledWith('/session/same-id?mobileSurface=collaboration&serverId=home-b&collaborationFocus=access');
    });

    it('carries no focus intent for an ordinary Collaboration entry', async () => {
        // `top` selects the mode but requests no focus move, so the destination is
        // never handed a one-shot focus intent it must consume and clear.
        const hook = await renderHook(() => useOpenSessionCollaboration({
            target: { serverId: 'home-b', sessionId: 'same-id' },
            replace: true,
        }));
        hook.getCurrent()();
        expect(route.replace).toHaveBeenLastCalledWith('/session/same-id?serverId=home-b&right=collaboration');
        expect(consumeSessionCollaborationIntent({ serverId: 'home-b', sessionId: 'same-id' })?.focusTarget).toBe('top');
    });

    it('opens the mounted pane while retaining the existing details state', async () => {
        const hook = await renderHook(() => {
            const pane = useAppPaneScope('session:home-b:same-id');
            return {
                pane,
                open: useOpenSessionCollaboration({ target: { serverId: 'home-b', sessionId: 'same-id' }, pane, focusTarget: 'access' }),
            };
        }, { wrapper: PaneWrapper });
        await act(async () => hook.getCurrent().pane.openDetailsTab(createWorkspaceFileDetailsTab('src/index.ts')));
        const detailsBefore = hook.getCurrent().pane.scopeState?.details;
        await act(async () => hook.getCurrent().open());
        expect(hook.getCurrent().pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'collaboration' });
        expect(hook.getCurrent().pane.scopeState?.details).toEqual(detailsBefore);
        expect(route.push).not.toHaveBeenCalled();
        expect(route.replace).not.toHaveBeenCalled();
        expect(consumeSessionCollaborationIntent({ serverId: 'home-b', sessionId: 'same-id' })?.focusTarget).toBe('access');
    });

    it('publishes the handing-off surface\'s typed query without putting it in the URL', async () => {
        const hook = await renderHook(() => useOpenSessionCollaboration({
            target: { serverId: 'home-b', sessionId: 'same-id' },
            replace: true,
            focusTarget: 'access',
        }));
        hook.getCurrent()({ query: 'ada lovelace' });
        // A private roster query is mounted-surface state, so it rides the
        // in-process mailbox only; the route keeps carrying the focus alone.
        expect(route.replace).toHaveBeenLastCalledWith('/session/same-id?serverId=home-b&collaborationFocus=access&right=collaboration');
        expect(consumeSessionCollaborationIntent({ serverId: 'home-b', sessionId: 'same-id' }))
            .toMatchObject({ focusTarget: 'access', query: 'ada lovelace' });

        // This same command is also the chip's `onOpen`, which the collapsed
        // composer action invokes with its focus-return ref. An options bag is
        // what keeps that positional argument from being read as a query.
        hook.getCurrent()({ current: null } as never);
        expect(consumeSessionCollaborationIntent({ serverId: 'home-b', sessionId: 'same-id' }))
            .not.toHaveProperty('query');
    });

    it('does not navigate while an exact Home target is unresolved', async () => {
        const hook = await renderHook(() => useOpenSessionCollaboration({ target: null }));
        hook.getCurrent()();
        expect(route.push).not.toHaveBeenCalled();
        expect(route.replace).not.toHaveBeenCalled();
    });
});
