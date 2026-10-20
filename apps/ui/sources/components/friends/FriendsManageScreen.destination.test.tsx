import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/friends/manage' }).module);

installDisconnectedServerSocketBoundary();
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { FriendsManageScreen } = await import('@/app/(app)/friends/manage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
let served: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let credentials: AuthCredentials | null = null;

beforeEach(async () => {
    served = await serveActionHomes({ homes: [{ key: 'friends', serverUrl: 'https://friends-destination.test',
        accountId: 'friends-owner', currentAccount: true, profile: { username: 'octocat' },
        settings: { experiments: true, featureToggles: { 'social.friends': true } } }],
        route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated' ? Response.json(buildServerFeaturesResponse({
            friendsEnabled: true, friendsAllowUsername: true, friendsRequiredIdentityProviderId: null,
        })) : undefined });
    credentials = await TokenStorage.getCredentialsForServerUrl('https://friends-destination.test');
    if (!credentials) throw new Error('Expected the admitted Friends Account fixture');
    await served.restoreActiveConnection();
    await getServerFeaturesSnapshot({ force: true });
    await vi.waitFor(() => {
        expect(storage.getState().profile.username).toBe('octocat');
        expect(storage.getState().settings.experiments).toBe(true);
        expect(storage.getState().settings.featureToggles['social.friends']).toBe(true);
    });
});
afterEach(async () => {
    standardCleanup();
    await served?.dispose();
    served = undefined;
    credentials = null;
});

describe('Friends management destination', () => {
    it.each([true, false])('keeps Add friend reachable once through the real page with phone=%s', async phone => {
        const opened: unknown[] = [];
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <DestinationInstanceHost tabId="friends" ref={{ kind: 'friendsManage', params: {} }} pathname="/friends/manage"
                focused visible phone={phone} navigation={{ push: href => { opened.push(href); }, replace: () => {}, back: () => {} }}>
                <FriendsManageScreen />
            </DestinationInstanceHost>
        </InjectedAuthProvider>);
        await vi.waitFor(() => {
            const controls = screen.findAllByTestId('friends-add-friend').filter(node => node.props.accessibilityRole === 'button');
            expect(controls, screen.getTextContent()).toHaveLength(1);
        });
        await screen.pressByTestIdAsync('friends-add-friend');
        expect(opened).toEqual(['/friends/search']);

        await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, username: null, linkedProviders: [] }); });
        expect(screen.findByTestId('friends-add-friend')).toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'textbox' }).length).toBeGreaterThan(0);
    });
});
