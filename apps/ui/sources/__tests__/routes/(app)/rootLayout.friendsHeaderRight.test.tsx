import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';


import { createOkFetchResponse, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
}));


vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/',
        segments: ['(app)'],
        router: routerMockState,
    }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => null,
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

function stubRootLayoutFeaturesFetch() {
    const payload = createRootLayoutFeaturesResponse();
    const fetchMock: typeof fetch = (() => createOkFetchResponse(payload)) as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    setRuntimeFetch(fetchMock);
}

async function renderRootLayout() {
    const { default: RootLayout } = await import('@/app/(app)/_layout');
    const screen = await renderScreen(<RootLayout />);
    await flushHookEffects({ cycles: 10, turns: 3 });
    return screen;
}

function getFriendsManageScreen(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const screens = screen.findAllByType(Stack.Screen) ?? [];
    return screens.find((node) => node.props?.name === 'friends/manage');
}

function getScreenNames(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return (screen.findAllByType(Stack.Screen) ?? [])
        .map((node) => node.props?.name)
        .filter((name): name is string => typeof name === 'string');
}

function getRegisteredScreen(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    name: string,
) {
    return (screen.findAllByType(Stack.Screen) ?? [])
        .find((node) => node.props?.name === name);
}

afterEach(() => {
    resetRuntimeFetch();
    vi.unstubAllGlobals();
});

describe('RootLayout', () => {
    it('declares Friends management only through the shared root options, with Add friend left to its page', async () => {
        stubRootLayoutFeaturesFetch();
        const tree = await renderRootLayout();
        try {
            const { createRootStackRouteOptions } = await import('@/components/navigation/root/rootStackRouteOptions');
            const friendsManage = getFriendsManageScreen(tree);
            expect(friendsManage).toBeTruthy();
            const options = friendsManage?.props?.options;
            expect(options).toMatchObject({ headerShown: true });
            expect(options.headerRight).toBeUndefined();
            expect(options).toEqual(createRootStackRouteOptions('auto')['friends/manage']);
        } finally {
            await tree?.unmount();
        }
    });

    it('registers session detail routes for tool and execution-run screens', async () => {
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('session/[id]/message/[messageId]');
            expect(screenNames).toContain('session/[id]/runs/new');
            expect(screenNames).toContain('session/[id]/runs/[runId]');
        } finally {
            await tree?.unmount();
        }
    });

    it('registers settings as a nested navigator', async () => {
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('settings');
        } finally {
            await tree?.unmount();
        }
    });

    it('registers project list and project detail source-control routes', async () => {
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('projects/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/files');
            expect(screenNames).toContain('projects/[workspaceRefId]/git');
            expect(screenNames).toContain('projects/[workspaceRefId]/details');
            expect(screenNames).toContain('projects/[workspaceRefId]/terminal');
        } finally {
            await tree?.unmount();
        }
    });

    it('renders terminal connect without the shell header on web', async () => {
        stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const terminalConnect = getRegisteredScreen(tree, 'terminal/connect');
            expect(terminalConnect).toBeTruthy();
            expect(terminalConnect?.props?.options).toMatchObject({
                headerShown: false,
            });
        } finally {
            await tree?.unmount();
        }
    });
});
