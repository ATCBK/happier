import * as React from 'react';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath } from '../governance/homeAdministrationRoutes';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const appsState = vi.hoisted(() => ({ current: { kind: 'loading' } as unknown }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: replaceMock } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('./useManagedGitHubApps', () => ({
    useManagedGitHubAppsClient: () => ({ execute: executeMock }),
    useManagedGitHubApps: () => ({ state: appsState.current, refresh: refreshMock }),
}));

import { ManagedGitHubAppEditorContent } from './ManagedGitHubAppEditorScreen';

function readyState(revision: number, githubClientId: string) {
    return {
        kind: 'ready' as const,
        stale: false,
        registrations: [{
            id: 'registration-1', owner: { kind: 'home' as const }, githubHost: 'https://github.com',
            githubAppId: '12', githubClientId, githubAppSlug: 'happier',
            githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision, securityRevision: 1,
            state: 'verified' as const,
            secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
            lastVerifiedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z',
        }],
        installations: [],
    };
}

const surface = {
    scope: { serverId: 'home-1', accountId: 'account-1' },
    owner: { kind: 'home' as const },
    mutationsAvailable: true,
    routes: {
        detail: (id: string) => homeAdministrationGitHubAppPath('home-1', id),
        edit: (id: string) => homeAdministrationGitHubAppEditPath('home-1', id),
        signIn: homeAdministrationPoliciesPath('home-1'),
    },
} as const;

function renderEditor() {
    return <ManagedGitHubAppEditorContent
        surface={surface}
        manifestReturn={{ kind: 'home', serverId: 'home-1' }}
        registrationId="registration-1"
    />;
}

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    refreshMock.mockReset();
    replaceMock.mockReset();
    appsState.current = readyState(2, 'Iv1.original');
});

describe('ManagedGitHubAppEditorContent revision and secret continuity', () => {
    it('preserves a dirty draft when a refresh advances the registration and saves only after explicit reload', async () => {
        const screen = await renderScreen(renderEditor());
        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.local-edit'));

        appsState.current = readyState(3, 'Iv1.remote-edit');
        await screen.update(renderEditor());

        expect(screen.findByTestId('github-app-client-id')?.props.value).toBe('Iv1.local-edit');
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull();

        await screen.pressByTestIdAsync('github-app-reload-conflict');
        expect(screen.findByTestId('github-app-client-id')?.props.value).toBe('Iv1.remote-edit');

        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.reviewed-edit'));
        executeMock.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { registration: readyState(4, 'Iv1.reviewed-edit').registrations[0] },
        });
        await screen.pressByTestIdAsync('github-app-save');

        expect(executeMock).toHaveBeenCalledWith(
            'identity.githubApps.update',
            expect.objectContaining({ expectedRevision: 3 }),
            expect.anything(),
        );
    });

    it('refreshes an Action CAS conflict and waits for a newer projection before offering reload', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { code: 'github_app_revision_conflict', retryable: false },
        });
        const screen = await renderScreen(renderEditor());
        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.local-edit'));

        await screen.pressByTestIdAsync('github-app-save');

        expect(refreshMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-reload-conflict')).toBeNull();
        await screen.pressByTestIdAsync('github-app-refresh-conflict');
        expect(refreshMock).toHaveBeenCalledTimes(2);

        appsState.current = readyState(3, 'Iv1.remote-edit');
        await screen.update(renderEditor());
        expect(screen.findByTestId('github-app-refresh-conflict')).toBeNull();
        expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull();
    });

    it('clears unsaved App secrets when the app leaves the active state', async () => {
        let onAppStateChange: ((state: string) => void) | null = null;
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
            onAppStateChange = listener as (state: string) => void;
            return { remove: vi.fn() };
        });
        const screen = await renderScreen(renderEditor());
        await act(async () => {
            screen.changeTextByTestId('github-app-client-secret', 'client-secret');
            screen.changeTextByTestId('github-app-private-key', 'private-key');
            screen.changeTextByTestId('github-app-webhook-secret', 'webhook-secret');
        });

        await act(async () => onAppStateChange?.('inactive'));

        expect(screen.findByTestId('github-app-client-secret')?.props.value).toBe('');
        expect(screen.findByTestId('github-app-private-key')?.props.value).toBe('');
        expect(screen.findByTestId('github-app-webhook-secret')?.props.value).toBe('');
    });

    it('does not offer local-only edits when mutations are unavailable', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={{ ...surface, mutationsAvailable: false }}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );

        expect(screen.findByTestId('github-app-client-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-client-secret')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-private-key')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-webhook-secret')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
    });
});
