import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { t } from '@/text';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
installDisconnectedServerSocketBoundary();
const { RequireFriendsIdentityForFriendsBase } = await import('./RequireFriendsIdentityForFriends');
afterEach(standardCleanup);

type BaseProps = React.ComponentProps<typeof RequireFriendsIdentityForFriendsBase>;

async function renderBase(overrides: Partial<BaseProps>) {
    const props: BaseProps = {
        variant: 'username',
        isReady: false,
        providerDisplayName: 'GitHub',
        onSaveUsername: () => {},
        onConnectProvider: () => {},
        children: <TextStub>CHILD</TextStub>,
        ...overrides,
    };
    return renderScreen(<RequireFriendsIdentityForFriendsBase {...props} />);
}

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('RequireFriendsIdentityForFriendsBase', () => {
    it('renders a username gate when identity is not ready and variant=username', async () => {
        const screen = await renderBase({});

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('profile.username') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('friends.providerGate.connect', { provider: 'GitHub' }) }).length).toBeGreaterThan(0);
    });

    it('prefills the username input when initialUsername is provided', async () => {
        const screen = await renderBase({ initialUsername: 'my_provider_name' });

        const usernameInputs = screen.findAllByProps({ accessibilityLabel: t('profile.username') });
        expect(usernameInputs.length).toBeGreaterThan(0);
        expect(usernameInputs[0]?.props?.value).toBe('my_provider_name');
    });

    it('renders a username hint when provided', async () => {
        const screen = await renderBase({ usernameHint: 'That name is already taken' });

        expect(screen.tree.findAllByProps({ children: 'That name is already taken' }).length).toBeGreaterThan(0);
    });

    it('renders a provider-only gate when variant=provider', async () => {
        const screen = await renderBase({
            variant: 'provider',
            providerDisplayName: 'GitHub',
        });

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('friends.providerGate.connect', { provider: 'GitHub' }) }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') })).toHaveLength(0);
    });

    it('shows a configuration hint when Not available? is pressed', async () => {
        const screen = await renderBase({
            variant: 'provider',
            unavailableReason: 'OAuth not configured',
        });

        expect(screen.tree.findAllByProps({ children: 'OAuth not configured' })).toHaveLength(0);

        const hintButtons = screen.tree.findAll(
            (node) =>
                node.props?.accessibilityLabel === t('friends.providerGate.notAvailable') &&
                typeof node.props?.onPress === 'function',
        );
        expect(hintButtons.length).toBeGreaterThan(0);

        await act(async () => {
            hintButtons[0]?.props?.onPress();
        });

        expect(screen.tree.findAllByProps({ children: 'OAuth not configured' }).length).toBeGreaterThan(0);
    });

    it('renders children when identity is ready', async () => {
        const screen = await renderBase({
            isReady: true,
        });

        expect(screen.tree.findAllByProps({ children: 'CHILD' }).length).toBeGreaterThan(0);
    });
});
