import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from '../../routeRootTestHelpers';
import { installRealActionExecutorModuleLoader, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installRouteRootCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: ({ data, renderItem, ItemSeparatorComponent, keyExtractor }: any) => (
                <>
                    {(data ?? []).map((item: any, index: number) => (
                        <React.Fragment key={keyExtractor ? keyExtractor(item, index) : String(item?.id ?? index)}>
                            {renderItem({ item, index })}
                            {ItemSeparatorComponent ? <ItemSeparatorComponent /> : null}
                        </React.Fragment>
                    ))}
                </>
            ),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: () => {} },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: async () => {},
            },
        }).module;
    },
});

vi.mock('@/hooks/friends/useRequireFriendsEnabled', () => ({
    useRequireFriendsEnabled: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/keyboardAvoidance', () => ({
    KeyboardAwareScrollView: ({ children, ...props }: any) =>
        React.createElement('KeyboardAwareScrollView', props, children),
}));

const hoisted = vi.hoisted(() => {
    const user = {
        id: 'u1',
        timestamp: 0,
        firstName: 'B',
        lastName: null,
        username: 'qa3b8089b',
        avatar: null,
        bio: null,
        publicKey: null,
        linkedProviders: [],
        connectedServices: [],
        status: 'none',
    };
    return { user };
});

vi.mock('@/hooks/search/useSearch', () => ({
    useSearch: () => ({
        results: [hoisted.user],
        isSearching: false,
        error: null,
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: () => null,
}));

describe('SearchFriendsScreen', () => {
    it('updates the user row status after sending a friend request', async () => {
        await initializeRealAppRuntimeForTests();
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://friends-screen.example',
            accountId: 'viewer', settings: { actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'friends.add': ['ui'] } } } }],
            route: request => {
                if (request.method === 'POST' && request.path === '/v1/friends/add') {
                    expect(request.accountId).toBe('viewer');
                    expect(request.body).toEqual({ uid: hoisted.user.id });
                    return Response.json({ user: { ...hoisted.user, status: 'requested' } });
                }
                return undefined;
            } });
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        try {
            const { SearchFriendsScreen } = await import('@/app/(app)/friends/search');
            const screen = await renderScreen(<SearchFriendsScreen />);
            await flushHookEffects({ cycles: 4, turns: 2 });

            expect(screen.findAllByType('KeyboardAwareScrollView' as any)).toHaveLength(1);
            expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
            const addFriendButton = screen.tree.findAllByType('TouchableOpacity')[0];
            expect(addFriendButton).toBeTruthy();
            await pressTestInstanceAsync(addFriendButton, 'friends.addFriend');

            // Expect the rendered status to reflect "requested" (sent).
            expect(screen.getTextContent()).toContain('friends.requestSent');
            expect(homes.requests.filter(request => request.path === '/v1/friends/add')).toHaveLength(1);
        } finally {
            disposeExecutor();
            await homes.dispose();
        }
    });
});
