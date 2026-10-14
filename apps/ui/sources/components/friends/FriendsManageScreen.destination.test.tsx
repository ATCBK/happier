import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/friends/manage' }).module);

installDisconnectedServerSocketBoundary();
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { FriendsManageScreen } = await import('@/app/(app)/friends/manage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { stubServerFeaturesFetch } = await import('@/hooks/server/serverFeaturesTestUtils');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

beforeEach(async () => {
    storage.getState().applySettings({ ...settingsDefaults, featureToggles: { 'social.friends': true } }, 1);
    storage.getState().applyProfile({ ...profileDefaults, username: 'octocat', linkedProviders: [] });
    await stubServerFeaturesFetch({ friendsEnabled: true, friendsAllowUsername: true, friendsRequiredIdentityProviderId: null });
    await getServerFeaturesSnapshot({ force: true });
});
afterEach(standardCleanup);

describe('Friends management destination', () => {
    it.each([true, false])('keeps Add friend reachable once through the real page with phone=%s', async phone => {
        const opened: unknown[] = [];
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <DestinationInstanceHost tabId="friends" ref={{ kind: 'friendsManage', params: {} }} pathname="/friends/manage"
                focused visible phone={phone} navigation={{ push: href => { opened.push(href); }, replace: () => {}, back: () => {} }}>
                <FriendsManageScreen />
            </DestinationInstanceHost>
        </InjectedAuthProvider>);
        const controls = screen.findAllByTestId('friends-add-friend').filter(node => node.props.accessibilityRole === 'button');
        expect(controls).toHaveLength(1);
        await screen.pressByTestIdAsync('friends-add-friend');
        expect(opened).toEqual(['/friends/search']);

        await act(async () => { storage.getState().applyProfile({ ...profileDefaults, username: null, linkedProviders: [] }); });
        expect(screen.findByTestId('friends-add-friend')).toBeNull();
        expect(screen.findAllByProps({ accessibilityRole: 'textbox' }).length).toBeGreaterThan(0);
    });
});
