import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { AccountSecuritySettingsScreen } from './AccountSecuritySettingsScreen';

const boundary = vi.hoisted(() => ({
    activeServerId: 'home-b',
    accountId: 'account-a',
    credentialsAccountId: 'account-b',
    scopeKind: 'bound' as 'bound' | 'signed_out' | 'unavailable',
    routeParams: { serverId: 'home-a', intent: 'email_password_connect', verificationToken: 'verify-home-a' } as Record<string, string>,
    routerPush: vi.fn(),
    read: vi.fn(),
    createClient: vi.fn(),
    openAccountSecurityForHome: vi.fn(),
    routerBack: vi.fn(),
    refreshAuth: vi.fn(async () => {}),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: boundary.routeParams,
        router: { back: boundary.routerBack, push: boundary.routerPush },
    }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        credentials: { token: boundary.credentialsAccountId },
        refreshFromActiveServer: boundary.refreshAuth,
    }),
}));
vi.mock('@/utils/auth/parseToken', () => ({ parseToken: (token: string) => token }));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: boundary.activeServerId, serverUrl: `https://${boundary.activeServerId}.test` }),
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: () => ({
        kind: boundary.scopeKind,
        scope: { serverId: 'home-a', accountId: boundary.accountId },
    }),
}));
vi.mock('./accountSecurityActionClient', () => ({
    createAccountSecurityActionClient: boundary.createClient,
}));
vi.mock('./openAccountSecurityForHome', () => ({
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT: 'email_password_connect',
    openAccountSecurityForHome: boundary.openAccountSecurityForHome,
}));
vi.mock('./AccountEmailPasswordSection', () => ({
    // The mounted section owns the one Account Security read; standing in for it
    // keeps this test about which Home may mount that reader at all.
    AccountEmailPasswordSection: () => {
        React.useEffect(() => { void boundary.read(); }, []);
        return React.createElement('AccountEmailPasswordSection', { testID: 'exact-account-security-section' });
    },
}));
vi.mock('./AccountEncryptionSettingsSection', () => ({ AccountEncryptionSettingsSection: () => null }));
vi.mock('./AccountSessionSecuritySection', () => ({ AccountSessionSecuritySection: () => null }));
vi.mock('@/components/settings/SettingsCatalogOverviewGroup', () => ({ SettingsCatalogPageChildren: () => null }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

beforeEach(() => {
    boundary.activeServerId = 'home-b';
    boundary.accountId = 'account-a';
    boundary.credentialsAccountId = 'account-b';
    boundary.scopeKind = 'bound';
    boundary.routerPush.mockReset();
    Object.assign(boundary.routeParams, { serverId: 'home-a', intent: 'email_password_connect', verificationToken: 'verify-home-a' });
    boundary.read.mockReset();
    boundary.read.mockResolvedValue({
        v: 1,
        encryptionMode: 'plain',
        nativeEmail: 'person@example.test',
        password: { status: 'not_enrolled', revision: null },
    });
    boundary.createClient.mockReset();
    boundary.createClient.mockImplementation(() => ({ read: boundary.read }));
    boundary.openAccountSecurityForHome.mockReset();
    boundary.openAccountSecurityForHome.mockResolvedValue(true);
    boundary.routerBack.mockReset();
    boundary.refreshAuth.mockClear();
});

afterEach(() => standardCleanup());

it('offers canonical Home recovery after credentials are revoked on an unqualified Security deep link', async () => {
    for (const key of Object.keys(boundary.routeParams)) delete boundary.routeParams[key];
    boundary.activeServerId = 'home-a';
    boundary.scopeKind = 'signed_out';
    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-signed-out')).not.toBeNull());
    expect(screen.findByTestId('settings-account-security-home-switching')).toBeNull();
    expect(boundary.read).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('settings-account-security-signed-out-action');
    expect(boundary.routerPush).toHaveBeenCalledWith('/server');
});

it('does not mount Home B Account Security from a Home A security-notice link', async () => {
    const screen = await renderScreen(<AccountSecuritySettingsScreen />);

    expect(boundary.read).not.toHaveBeenCalled();
    expect(screen.findByTestId('exact-account-security-section')).toBeNull();
    expect(boundary.createClient.mock.calls.at(-1)?.[0].resolveServerId()).toBe('home-a');
    await vi.waitFor(() => expect(boundary.openAccountSecurityForHome).toHaveBeenCalledWith(expect.objectContaining({
        serverId: 'home-a',
    })));

    boundary.activeServerId = 'home-a';
    boundary.credentialsAccountId = 'account-a';
    await screen.update(<AccountSecuritySettingsScreen key="home-a-active" />);

    await vi.waitFor(() => expect(boundary.read).toHaveBeenCalled());
    expect(screen.findByTestId('exact-account-security-section')).not.toBeNull();
    expect(boundary.createClient.mock.calls.at(-1)?.[0].resolveServerId()).toBe('home-a');
});

it('shows an accessible loading state while the exact Home switch is pending', async () => {
    boundary.openAccountSecurityForHome.mockImplementationOnce(async () => await new Promise<boolean>(() => {}));

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);

    await vi.waitFor(() => expect(boundary.openAccountSecurityForHome).toHaveBeenCalled());
    // The page keeps its header and reserves its rows (announced as busy), with no "Loading…" card.
    const loading = screen.findHostByTestId('settings-account-security-home-switching');
    expect(loading?.props.accessibilityState).toEqual({ busy: true });
    expect(screen.getTextContent()).not.toContain('common.loading');
    expect(screen.findByTestId('exact-account-security-section')).toBeNull();
});

it.each([
    ['blocked', async () => false],
    ['rejected', async () => { throw new Error('switch unavailable'); }],
])('shows recovery without mounting the wrong Account Security consumer when switching is %s', async (_name, outcome) => {
    boundary.openAccountSecurityForHome.mockImplementationOnce(outcome);

    const screen = await renderScreen(<AccountSecuritySettingsScreen />);

    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-home-switch-failed')).not.toBeNull());
    const failure = screen.findByTestId('settings-account-security-home-switch-failed');
    expect(failure?.props.accessibilityRole).toBe('alert');
    expect(screen.findByTestId('settings-account-security-home-switch-failed-action')).not.toBeNull();
    expect(screen.findByTestId('settings-account-security-home-switch-failed-secondary-action')).not.toBeNull();
    expect(screen.findByTestId('exact-account-security-section')).toBeNull();
    expect(boundary.read).not.toHaveBeenCalled();
});

it('retries the original Home Security intent and mounts consumers only after exact scope becomes active', async () => {
    boundary.openAccountSecurityForHome
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-home-switch-failed')).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-security-home-switch-failed-action');

    await vi.waitFor(() => expect(boundary.openAccountSecurityForHome).toHaveBeenCalledTimes(2));
    expect(boundary.openAccountSecurityForHome).toHaveBeenLastCalledWith(expect.objectContaining({
        serverId: 'home-a',
        intent: 'email_password_connect',
        verificationToken: 'verify-home-a',
    }));
    expect(screen.findByTestId('exact-account-security-section')).toBeNull();

    boundary.activeServerId = 'home-a';
    boundary.credentialsAccountId = 'account-a';
    await screen.update(<AccountSecuritySettingsScreen key="home-a-active-after-retry" />);

    await vi.waitFor(() => expect(boundary.read).toHaveBeenCalled());
    expect(screen.findByTestId('exact-account-security-section')).not.toBeNull();
});

it('backs out through the existing router without attempting Account Security work', async () => {
    boundary.openAccountSecurityForHome.mockResolvedValueOnce(false);
    const screen = await renderScreen(<AccountSecuritySettingsScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-home-switch-failed')).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-security-home-switch-failed-secondary-action');

    expect(boundary.routerBack).toHaveBeenCalledOnce();
    expect(boundary.read).not.toHaveBeenCalled();
});
