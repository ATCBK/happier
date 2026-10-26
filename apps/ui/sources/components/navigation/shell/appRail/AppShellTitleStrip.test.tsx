import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

const router = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }));

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: () => '/settings/appearance', router }).module;
    },
});

vi.mock('@/components/inbox/actionOperations/ActionOperationActivityButton', () => ({
    ActionOperationActivityButton: () => null,
}));

afterEach(() => {
    standardCleanup();
    router.navigate.mockReset();
    router.push.mockReset();
});

describe('AppShellTitleStrip', () => {
    // The 24 px controls sit 8 px apart: a finger's hit area takes half of that on each side, so Back, Next and
    // the column toggle meet without overlapping.
    it('splits the gap between its controls instead of reaching 10 px into the next one', async () => {
        const { AppShellTitleStrip } = await import('./AppShellTitleStrip');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} />
            </HappierUiPlatformProvider>,
        );
        for (const id of ['app-shell-back', 'app-shell-forward', 'app-shell-column-toggle']) {
            const reach = readHitFrameReach(screen.findByTestId(id)!);
            expect([reach?.left, reach?.right]).toEqual([4, 4]);
        }
    });
    it('uses workspace availability and actions for the shell history controls', async () => {
        const navigation = { canGoBack: true, canGoForward: true, back: vi.fn(), forward: vi.fn(), openHref: vi.fn() };
        const { AppShellTitleStrip } = await import('./AppShellTitleStrip');
        const screen = await renderScreen(
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} navigation={navigation} />,
        );
        const back = screen.findByTestId('app-shell-back');
        const forward = screen.findByTestId('app-shell-forward');
        if (!back || !forward) throw new Error('Expected both shell history controls');
        expect(back.props.disabled).toBe(false);
        expect(forward.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('app-shell-back');
        await screen.pressByTestIdAsync('app-shell-forward');
        await screen.pressByTestIdAsync('app-shell-logo');
        expect(navigation.back).toHaveBeenCalledOnce();
        expect(navigation.forward).toHaveBeenCalledOnce();
        expect(navigation.openHref).toHaveBeenCalledWith('/');
        expect(router.push).not.toHaveBeenCalled();
    });
    it('leads with the Happier logo, which opens the home screen, then back, forward and the column toggle', async () => {
        const { AppShellTitleStrip } = await import('./AppShellTitleStrip');
        const screen = await renderScreen(
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} />,
        );
        const order = ['app-shell-logo', 'app-shell-back', 'app-shell-forward', 'app-shell-column-toggle'];
        const rendered = screen.root
            .findAll((node) => typeof node.props?.testID === 'string' && order.includes(node.props.testID))
            .map((node) => node.props.testID as string)
            .filter((id, index, all) => all.indexOf(id) === index);
        expect(rendered).toEqual(order);

        await screen.pressByTestIdAsync('app-shell-logo');
        const opened = [...router.navigate.mock.calls, ...router.push.mock.calls].map((call) => call[0]);
        expect(opened).toEqual(['/']);
    });
    it('keeps the workspace tabs clear of the trailing accessories when the window widens without resizing them', async () => {
        const { View } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { AppShellTitleStrip } = await import('./AppShellTitleStrip');
        const { WorkspaceTitleBar } = await import('@/components/appShell/workspace/titleBar/WorkspaceTitleBar');
        const screen = await renderScreen(
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} workspaceCatalog={[]} trailing={<View />} />,
        );
        const layout = (testID: string, x: number, width: number) => screen.findByTestId(testID)?.props.onLayout?.({ nativeEvent: { layout: { x, y: 0, width, height: 40 } } });
        await act(async () => {
            layout('app-shell-title-strip', 0, 1400);
            layout('app-shell-title-strip-trailing', 1328, 60);
        });
        expect(screen.root.findByType(WorkspaceTitleBar).props.trailingStartPx).toBe(1400 - 12 - 60 - 12);
        // Widening moves the accessories without resizing them: only the strip reports a new size.
        await act(async () => { layout('app-shell-title-strip', 0, 1920); });
        expect(screen.root.findByType(WorkspaceTitleBar).props.trailingStartPx).toBe(1920 - 12 - 60 - 12);
    });
});
