import * as React from 'react';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath, homeAdministrationSignInProvidersPath } from '../governance/homeAdministrationRoutes';
import { teamDirectoryPath } from '../../teams/teamsRoutes';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

// Keep this focused screen test off the aggregate testkit barrel: that barrel
// intentionally exports unrelated Session fixtures and would make a GitHub
// administration test depend on every Protocol Action module loading first.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

const executeMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());
const approvalPendingMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: replaceMock, push: pushMock } }).module;
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: announceMock,
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: vi.fn(async () => true),
        alertAsync: vi.fn(async () => {}),
    },
}));
// The content-level flow under test receives its already-qualified surface.
// Keep the unrelated Home administration shell out of this focused screen lane.
vi.mock('../governance/HomeAdministrationSection', () => ({ HomeAdministrationSection: 'HomeAdministrationSection' }));
vi.mock('./ManagedGitHubAppsSection', () => ({
    homeManagedGitHubAppSurface: vi.fn(),
    managedGitHubAppDisplayName: (registration: Readonly<{ githubAppSlug?: string | null; githubHost: string }>) => (
        registration.githubAppSlug ?? registration.githubHost
    ),
    managedGitHubAppStateLabel: (state: string) => state === 'verified'
        ? 'identityAdministration.githubVerified'
        : state,
}));
vi.mock('./useManagedGitHubApps', () => ({
    useManagedGitHubAppsClient: () => ({ execute: executeMock }),
    useManagedGitHubApps: () => ({
        state: {
            kind: 'ready',
            stale: false,
            registrations: [{
                id: 'registration-1', owner: { kind: 'home' }, githubHost: 'https://github.com',
                githubAppId: '12', githubClientId: 'Iv1.client', githubAppSlug: 'happier',
                githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision: 2, securityRevision: 1,
                state: 'verified',
                secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
                lastVerifiedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
                updatedAt: '2026-09-01T10:00:00.000Z',
            }],
            installations: [{
                id: 'installation-1', registrationId: 'registration-1', githubInstallationId: '1',
                githubOrganizationId: '2', githubOrganizationLogin: 'happier-dev', repositorySelection: 'all',
                revision: 1, state: 'verified', verifiedPermissions: {}, verifiedEvents: [],
                suspendedAt: null, lastVerifiedAt: null,
                teamConsumers: [
                    {
                        team: { id: 'team-1', name: 'Acme' },
                        binding: {
                            kind: 'identity_connection', id: 'connection-1',
                            providerInstanceId: 'provider-1', enabled: true,
                        },
                    },
                    {
                        team: { id: 'team-1', name: 'Acme' },
                        binding: { kind: 'directory_source', id: 'source-1', state: 'active' },
                    },
                ],
            }],
        },
        refresh: refreshMock,
    }),
}));

import { ManagedGitHubAppDetailContent } from './ManagedGitHubAppDetailScreen';
import { ManagedGitHubAppEditorContent } from './ManagedGitHubAppEditorScreen';
import {
    consumePendingGitHubAppManifestSetup,
    consumePendingGitHubAppVerification,
} from './githubAppOAuthReturn';

function approval(artifactId: string) {
    return {
        artifactId,
        onExecuted: vi.fn(async () => 'consumed' as const),
        onTerminal: vi.fn(),
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
        directory: teamDirectoryPath({ serverId: 'home-1', teamId: 'team-1' }),
    },
    githubEnterpriseOriginPolicyPath: homeAdministrationSignInProvidersPath('home-1'),
    onApprovalPending: approvalPendingMock,
} as const;

async function changeText(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    values: Readonly<Record<string, string>>,
): Promise<void> {
    await act(async () => {
        for (const [testID, value] of Object.entries(values)) {
            screen.changeTextByTestId(testID, value);
        }
    });
}

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    refreshMock.mockReset();
    replaceMock.mockReset();
    pushMock.mockReset();
    openExternalUrlMock.mockReset();
    announceMock.mockReset();
    approvalPendingMock.mockReset();
    consumePendingGitHubAppManifestSetup();
    consumePendingGitHubAppVerification('registration-1');
});

describe('managed GitHub App approval-pending consumers', () => {
    it('routes identity and directory setup to their canonical owners without claiming facet state', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-sign-in')!, 'Text', 'identityAdministration.githubFacetConfigure')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-directory')!, 'Text', 'identityAdministration.githubFacetConfigure')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-team-consumer:identity_connection:connection-1')!, 'Text', 'Acme')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-team-consumer:directory_source:source-1')!, 'Text', 'identityAdministration.githubFacetDirectory')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-installation:installation-1')!, 'Text', 'identityAdministration.githubVerified')).toBeDefined();

        await screen.pressByTestIdAsync('github-app-sign-in');
        await screen.pressByTestIdAsync('github-app-directory');

        expect(pushMock).toHaveBeenNthCalledWith(1, '/settings/home/home-1/policies');
        expect(pushMock).toHaveBeenNthCalledWith(2, '/settings/teams/home-1/team-1/authentication/directory');
    });

    it('keeps installation verification fields read-only when mutations are unavailable', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent
                surface={{ ...surface, mutationsAvailable: false }}
                registrationId="registration-1"
            />,
        );

        expect(screen.findByTestId('github-installation-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-organization-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-installation-verify')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-edit')?.props.disabled).toBe(true);
    });

    it('starts only one manual save when pressed twice before React renders busy state', async () => {
        let releaseSave = (_value: unknown): void => {};
        executeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        act(() => {
            screen.pressByTestId('github-app-save');
            screen.pressByTestId('github-app-save');
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => releaseSave({
            kind: 'approval_pending', artifactId: 'approval-1', approval: approval('approval-1'),
        }));
    });

    it('starts only one manifest setup when pressed twice before React renders busy state', async () => {
        let releaseSetup = (_value: unknown): void => {};
        executeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseSetup = resolve; }));
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, { 'github-manifest-app-name': 'Happier' });

        act(() => {
            screen.pressByTestId('github-manifest-start');
            screen.pressByTestId('github-manifest-start');
        });
        expect(executeMock).toHaveBeenCalledTimes(1);

        await act(async () => releaseSetup({
            kind: 'approval_pending', artifactId: 'approval-1', approval: approval('approval-1'),
        }));
    });

    it('keeps a create draft in place and exits busy without success navigation', async () => {
        const pendingApproval = approval('approval-1');
        executeMock.mockResolvedValueOnce({ kind: 'approval_pending', artifactId: 'approval-1', approval: pendingApproval });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');

        expect(replaceMock).not.toHaveBeenCalled();
        expect(screen.findAll((node) => node.props.description === 'connect.waitingForApproval')).not.toHaveLength(0);
        expect(Boolean(screen.findByTestId('github-app-save')!.props.accessibilityState?.busy)).toBe(false);
        expect(screen.findByTestId('github-app-private-key')?.props.value).toBe('private-key');
        expect(announceMock).toHaveBeenCalledWith('connect.waitingForApproval');
        expect(approvalPendingMock).toHaveBeenCalledWith(pendingApproval);
    });

    it('continues an approved create through the same success callback without replaying the Action', async () => {
        const pendingApproval = approval('approval-create');
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-create', approval: pendingApproval,
        });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');
        const callbacks = executeMock.mock.calls[0]?.[2];
        await act(async () => callbacks?.onApprovalSucceeded?.({ registration: { id: 'created-registration' } }));

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(replaceMock).toHaveBeenCalledWith(homeAdministrationGitHubAppPath('home-1', 'created-registration'));
    });

    it('continues an approved update through the same success callback without replaying the Action', async () => {
        const pendingApproval = approval('approval-update');
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-update', approval: pendingApproval,
        });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );
        await changeText(screen, { 'github-app-client-id': 'Iv1.changed' });

        await screen.pressByTestIdAsync('github-app-save');
        const callbacks = executeMock.mock.calls[0]?.[2];
        await act(async () => callbacks?.onApprovalSucceeded?.({ registration: { id: 'registration-1' } }));

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(replaceMock).toHaveBeenCalledWith(homeAdministrationGitHubAppPath('home-1', 'registration-1'));
        expect(approvalPendingMock).toHaveBeenCalledWith(pendingApproval);
    });

    it('does not record or open manifest setup before the Action is approved', async () => {
        const pendingApproval = approval('approval-manifest');
        executeMock.mockResolvedValueOnce({ kind: 'approval_pending', artifactId: 'approval-manifest', approval: pendingApproval });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, { 'github-manifest-app-name': 'Happier' });

        await screen.pressByTestIdAsync('github-manifest-start');

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(screen.findAll((node) => node.props.description === 'connect.waitingForApproval')).not.toHaveLength(0);
        expect(Boolean(screen.findByTestId('github-manifest-start')!.props.accessibilityState?.busy)).toBe(false);
        expect(approvalPendingMock).toHaveBeenCalledWith(pendingApproval);
    });

    it('opens an approved manifest setup once and retains no retry-blocking busy state', async () => {
        const pendingApproval = approval('approval-manifest');
        openExternalUrlMock.mockResolvedValueOnce(true);
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-manifest', approval: pendingApproval,
        });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, { 'github-manifest-app-name': 'Happier' });

        await screen.pressByTestIdAsync('github-manifest-start');
        const callbacks = executeMock.mock.calls[0]?.[2];
        await act(async () => callbacks?.onApprovalSucceeded?.({ authorizeUrl: 'https://github.com/settings/apps/new' }));

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/settings/apps/new');
        expect(consumePendingGitHubAppManifestSetup()).toEqual({ kind: 'home', serverId: 'home-1' });
        expect(Boolean(screen.findByTestId('github-manifest-start')!.props.accessibilityState?.busy)).toBe(false);
    });

    it('does not open installation verification before approval', async () => {
        const pendingApproval = approval('approval-verify');
        executeMock.mockResolvedValueOnce({ kind: 'approval_pending', artifactId: 'approval-verify', approval: pendingApproval });
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        await changeText(screen, {
            'github-installation-id': '3',
            'github-organization-id': '4',
        });

        await screen.pressByTestIdAsync('github-installation-verify');

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-notice')!, 'Text', 'connect.waitingForApproval')).toBeDefined();
        expect(Boolean(screen.findByTestId('github-installation-verify')!.props.disabled)).toBe(false);
        expect(approvalPendingMock).toHaveBeenCalledWith(pendingApproval);
    });

    it('opens an approved installation verification once and binds its exact return', async () => {
        const pendingApproval = approval('approval-verify');
        openExternalUrlMock.mockResolvedValueOnce(true);
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-verify', approval: pendingApproval,
        });
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        await changeText(screen, {
            'github-installation-id': '3',
            'github-organization-id': '4',
        });

        await screen.pressByTestIdAsync('github-installation-verify');
        const callbacks = executeMock.mock.calls[0]?.[2];
        await act(async () => callbacks?.onApprovalSucceeded?.({
            authorizeUrl: 'https://github.com/login/oauth/authorize',
            attemptId: 'attempt-1',
        }));

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/oauth/authorize');
        expect(consumePendingGitHubAppVerification('registration-1')).toEqual({
            registrationId: 'registration-1',
            returnTo: homeAdministrationGitHubAppPath('home-1', 'registration-1'),
        });
    });

    it('makes a rejected setup retryable without replaying the Action', async () => {
        const pendingApproval = approval('approval-rejected');
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-rejected', approval: pendingApproval,
        });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, { 'github-manifest-app-name': 'Happier' });
        await screen.pressByTestIdAsync('github-manifest-start');

        const callbacks = executeMock.mock.calls[0]?.[2];
        act(() => callbacks?.onApprovalFailed?.('approval_rejected'));

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(Boolean(screen.findByTestId('github-manifest-start')!.props.disabled)).toBe(false);
        expect(screen.findAll((node) => node.props.description === 'identityAdministration.error')).not.toHaveLength(0);
    });

    it('does not refresh after a pending installation removal', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'approval_pending', artifactId: 'approval-1', approval: approval('approval-1'),
        });
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        await screen.pressByTestIdAsync('github-app-installation-remove:installation-1');

        expect(refreshMock).not.toHaveBeenCalled();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-notice')!, 'Text', 'connect.waitingForApproval')).toBeDefined();
        expect(Boolean(screen.findByTestId('github-app-installation-remove:installation-1')!.props.disabled)).toBe(false);
    });

    it('preserves a Home-owned create draft and opens the exact Home policy after an unapproved enterprise origin', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { code: 'github_enterprise_origin_not_approved', retryable: false },
        });
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-host': 'https://github.corp.example',
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');

        expect(replaceMock).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('github-app-save')!.props.accessibilityState?.busy)).toBe(false);
        expect(screen.findByTestId('github-app-host')?.props.value).toBe('https://github.corp.example');
        expect(screen.findByTestId('github-app-private-key')?.props.value).toBe('private-key');
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-enterprise-origin-policy')!, 'Text', 'homeGovernance.githubEnterpriseOrigins')).toBeDefined();
        expect(screen.findAll((node) => node.props.description
            === 'identityAdministration.githubEnterpriseOriginNotApproved')).not.toHaveLength(0);

        await screen.pressByTestIdAsync('github-enterprise-origin-policy');
        expect(pushMock).toHaveBeenCalledWith(homeAdministrationSignInProvidersPath('home-1'));
    });

    it('offers the same exact-Home recovery from installation verification without reporting success', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { code: 'github_enterprise_origin_not_approved', retryable: false },
        });
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        await changeText(screen, {
            'github-installation-id': '3',
            'github-organization-id': '4',
        });

        await screen.pressByTestIdAsync('github-installation-verify');

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('github-installation-verify')!.props.disabled)).toBe(false);
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-enterprise-origin-policy')!, 'Text', 'homeGovernance.githubEnterpriseOrigins')).toBeDefined();
        await screen.pressByTestIdAsync('github-enterprise-origin-policy');
        expect(pushMock).toHaveBeenCalledWith(homeAdministrationSignInProvidersPath('home-1'));
    });

    it('does not invent Home policy navigation for a Team-owned GitHub App', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { code: 'github_enterprise_origin_not_approved', retryable: false },
        });
        const { githubEnterpriseOriginPolicyPath: _homePolicyPath, ...sharedSurface } = surface;
        const teamSurface = {
            ...sharedSurface,
            owner: { kind: 'team' as const, teamId: 'team-1' },
        };
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={teamSurface}
                manifestReturn={{ kind: 'team', serverId: 'home-1', teamId: 'team-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-host': 'https://github.corp.example',
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');

        expect(screen.findByTestId('github-enterprise-origin-policy')).toBeNull();
        expect(pushMock).not.toHaveBeenCalled();
    });

    it('explains an unenumerated Home failure instead of printing its code', async () => {
        executeMock.mockResolvedValueOnce({
            kind: 'failed',
            failure: { code: 'github_installation_unverified', retryable: false },
        });
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        await changeText(screen, {
            'github-installation-id': '1',
            'github-organization-id': '2',
        });
        await screen.pressByTestIdAsync('github-installation-verify');

        // The classifier's answer, not the wire enum. A raw code here is the
        // regression: it is unlocalized and means nothing to an administrator.
        const footers = screen.findAll((node) => typeof node.props.description === 'string'
            && node.props.description.length > 0);
        expect(footers.map((node) => node.props.description))
            .not.toContain('github_installation_unverified');
        expect(footers.map((node) => node.props.description))
            .toContain('identityAdministration.error');
    });
});
