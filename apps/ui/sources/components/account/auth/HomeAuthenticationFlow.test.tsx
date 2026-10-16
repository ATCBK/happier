import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { HomeAuthenticationAction } from '@/auth/capabilities/authMethodCapabilities';
import { AuthProvider } from '@/auth/context/AuthContext';

const executeHomeAuthenticationMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/auth/flows/executeHomeAuthentication', () => ({
    executeHomeAuthentication: executeHomeAuthenticationMock,
}));

import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';

const keyAction: HomeAuthenticationAction = {
    method: { id: 'key_challenge', enabledActions: [{ id: 'login', mode: 'keyed' }] },
    action: { id: 'login', mode: 'keyed' },
    execution: { kind: 'key_entry' },
};

const oauthAction: HomeAuthenticationAction = {
    method: {
        id: 'team-oidc',
        enabledActions: [{ id: 'connect', mode: 'either' }],
        presentation: { displayName: 'Acme SSO' },
    },
    action: { id: 'connect', mode: 'either' },
    execution: { kind: 'oauth', providerId: 'team-oidc', mode: 'keyed' },
};

const mtlsAction: HomeAuthenticationAction = {
    method: {
        id: 'mtls',
        enabledActions: [{ id: 'login', mode: 'keyless' }],
        presentation: { displayName: 'Certificate' },
    },
    action: { id: 'login', mode: 'keyless' },
    execution: { kind: 'mtls' },
};

describe('HomeAuthenticationFlow', () => {
    it('returns from exact key entry to the admitted method chooser', async () => {
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[keyAction]}
                returnTo="/setup/wizard"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await screen.pressByTestIdAsync('home-auth-key_challenge-login-keyed');
        expect(screen.findByTestId('home-auth-key-back')).toBeTruthy();

        await screen.pressByTestIdAsync('home-auth-key-back');
        expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).toBeTruthy();
    });

    it('opens a chosen key form directly, leaving the step\'s own back as the only way out', async () => {
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[keyAction]}
                openChosenAction
                returnTo="/setup/wizard"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).toBeNull();
        expect(screen.findByTestId('home-auth-key-back')).toBeNull();
    });

    it('runs a chosen one-tap action on arrival, so the person\'s one tap is the only tap', async () => {
        executeHomeAuthenticationMock.mockReset();
        const generatedKeyAction: HomeAuthenticationAction = {
            method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
            action: { id: 'provision', mode: 'keyed' },
            execution: { kind: 'generated_key' },
        };
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[generatedKeyAction]}
                openChosenAction
                returnTo="/teams/team-1/sign-in?serverId=srv_home"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        expect(executeHomeAuthenticationMock).toHaveBeenCalledTimes(1);
        expect(executeHomeAuthenticationMock).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ execution: { kind: 'generated_key' } }),
        }));
        // No Back card beside the step's own back, and the card stays as the retry if the run did not finish.
        expect(screen.findByTestId('home-auth-back')).toBeNull();
        expect(screen.findByTestId('home-auth-key_challenge-provision-keyed')).toBeTruthy();
    });

    it('does not run any action on arrival when the caller did not choose one', async () => {
        executeHomeAuthenticationMock.mockReset();
        await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[oauthAction]}
                returnTo="/teams/team-1/sign-in?serverId=srv_home"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        expect(executeHomeAuthenticationMock).not.toHaveBeenCalled();
    });

    it('forwards explicit Team admission context to the shared authentication executor', async () => {
        executeHomeAuthenticationMock.mockReset();
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[oauthAction]}
                returnTo="/teams/team-1/sign-in?serverId=srv_home"
                teamAdmission={{ teamId: 'team-1' }}
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await screen.pressByTestIdAsync('home-auth-team-oidc-connect-either');

        expect(executeHomeAuthenticationMock).toHaveBeenCalledWith(expect.objectContaining({
            teamAdmission: { teamId: 'team-1' },
        }));
    });

    it('forwards native Team mTLS through the shared authentication executor', async () => {
        executeHomeAuthenticationMock.mockReset();
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[mtlsAction]}
                returnTo="/teams/team-1/sign-in?target=srv_home"
                teamAdmission={{ teamId: 'team-1' }}
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await screen.pressByTestIdAsync('home-auth-mtls-login-keyless');

        expect(executeHomeAuthenticationMock).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ execution: { kind: 'mtls' } }),
            teamAdmission: { teamId: 'team-1' },
        }));
    });
});
