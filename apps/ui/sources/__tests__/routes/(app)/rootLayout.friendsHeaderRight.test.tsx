import { initializeRealAppRuntimeForTests as initializeRootLayoutRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { renderRealAppRoute } from '@/dev/testkit/render/renderRealAppRoute';
import { RootLayoutRouteContexts } from "./rootLayoutRouteContexts";

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';


import { createRootLayoutFeaturesResponse, flushHookEffects, renderScreen } from '@/dev/testkit';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

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

vi.mock('expo-router/build/fork/getPathFromState', async () => {
    const { loadInstalledExpoPathSerializer } = await import('@/dev/testkit/runtime/installedExpoPathSerializer');
    return loadInstalledExpoPathSerializer();
});

async function stubRootLayoutFeaturesFetch() {
    await seedPersistedHomeProfilesForTests({ activeServerId: 'friends-home', profiles: [{ id: 'friends-home', serverUrl: 'https://friends.example.test', name: 'Friends', createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' }] });
    resetServerFeaturesClientForTests();
    const payload = createRootLayoutFeaturesResponse({ capabilities: {
        social: { friends: { allowUsername: true, requiredIdentityProviderId: 'github' } },
    } });
    const fetchMock: typeof fetch = async () => Response.json(payload);
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    setRuntimeFetch(fetchMock);
    expect(await getServerFeaturesSnapshot({ serverId: 'friends-home', force: true })).toMatchObject({ status: 'ready', features: { capabilities: { social: { friends: { allowUsername: true } } } } });
}

async function renderRootLayout() {
    const { default: RootLayout } = await import('@/app/(app)/_layout');
    const screen = await renderRealAppRoute(RootLayout, null, { contextWrapper: RootLayoutRouteContexts });
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

await initializeRootLayoutRuntimeForTests();

afterEach(() => {
    resetRuntimeFetch();
    vi.unstubAllGlobals();
});

describe('RootLayout', () => {
    it('declares Friends management only through the shared root options, with Add friend left to its page', async () => {
        await stubRootLayoutFeaturesFetch();
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

    it('registers the session navigator for tool and execution-run sub-pages', async () => {
        await stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('session/[id]');
            expect(screenNames.filter(name => name.startsWith('session/[id]/'))).toEqual([]);
        } finally {
            await tree?.unmount();
        }
    });

    it('registers settings as a nested navigator', async () => {
        await stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('settings');
        } finally {
            await tree?.unmount();
        }
    });

    it('registers project list and project detail source-control routes', async () => {
        await stubRootLayoutFeaturesFetch();

        const tree = await renderRootLayout();
        try {
            const screenNames = getScreenNames(tree);

            expect(screenNames).toContain('projects/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/index');
            expect(screenNames).toContain('projects/[workspaceRefId]/code');
            expect(screenNames).toContain('projects/[workspaceRefId]/changes');
            expect(screenNames).toContain('projects/[workspaceRefId]/overview');
            expect(screenNames).toContain('projects/[workspaceRefId]/terminal');
        } finally {
            await tree?.unmount();
        }
    });

    it('renders terminal connect without the shell header on web', async () => {
        await stubRootLayoutFeaturesFetch();

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
