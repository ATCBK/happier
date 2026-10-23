import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

const harness = vi.hoisted(() => ({
    controllerProps: null as Record<string, unknown> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: {
            q: 'needle',
            sessionId: 'captured-session',
            serverId: 'home-a',
            accountId: 'account-a',
        },
    }).module;
});

vi.mock('@/components/appShell/search/UniversalSearchController', () => ({
    UniversalSearchController: (props: Record<string, unknown>) => {
        harness.controllerProps = props;
        return React.createElement('UniversalSearchController', props);
    },
}));

vi.mock('@/components/ui/layout/ConstrainedScreenContent', () => ({
    ConstrainedScreenContent: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('ConstrainedScreenContent', props, props.children)
    ),
}));

afterEach(() => {
    harness.controllerProps = null;
    standardCleanup();
});

describe('/search Universal Search command context', () => {
    it('builds route commands for the Session captured by the Search invocation', async () => {
        const buildCommands = vi.fn(() => [{
            id: 'session-only-command',
            title: 'Session-only command',
            action: vi.fn(),
        }]);
        const Route = (await import('@/app/(app)/search')).default;

        await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open: vi.fn(), buildCommands }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        expect(buildCommands).toHaveBeenCalledWith('captured-session', expect.objectContaining({
            sessionId: 'captured-session',
            serverId: 'home-a',
        }), undefined);
        expect(harness.controllerProps?.commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'session-only-command' }),
        ]));
    });

    it('frames the direct web route with the canonical application content-width owner', async () => {
        const Route = (await import('@/app/(app)/search')).default;

        const screen = await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open: vi.fn(), buildCommands: vi.fn(() => []) }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        const page = screen.root.findByProps({ testID: 'universal-search-route-page' });
        expect(page.findByType('ConstrainedScreenContent' as never)).toBeTruthy();
        expect(page.findAllByType('UniversalSearchController' as never)).toHaveLength(1);
    });

    it('exposes a route-owned close control on the direct web Search page', async () => {
        const Route = (await import('@/app/(app)/search')).default;
        const screen = await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open: vi.fn(), buildCommands: vi.fn(() => []) }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        const close = screen.root.findByProps({ testID: 'universal-search-route-close' });
        expect(close.props.accessibilityLabel).toBe('Close');
        expect(typeof close.props.onPress).toBe('function');
    });
});
