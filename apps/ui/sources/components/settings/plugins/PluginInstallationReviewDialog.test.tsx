// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

import { renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));
const modalState = vi.hoisted(() => ({ show: vi.fn() }));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: modalState.show } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (
                params ? `${key}:${JSON.stringify(params)}` : key
            ),
        });
    },
});

// Transform the real dialog during collection; its cold dependency graph is
// setup work, outside the decision and focus interaction budgets below.
await import('./PluginInstallationReviewDialog');

describe('PluginInstallationReviewDialog', () => {
    const review = createPluginInstallationReviewFixture({
        packageIdentity: { name: '@acme/example', version: '1.0.0' },
        source: { kind: 'npm', locator: '@acme/example@1.0.0', integrity: 'sha512-example', integrityBasis: 'expected' },
        updateChannel: {
            kind: 'npm',
            packageName: '@acme/example',
            registryOrigin: 'https://registry.npmjs.org',
            marketplaceSource: { id: 'community-npm', kind: 'community-npm', sourceUrl: 'https://registry.npmjs.org' },
        },
        curation: { status: 'unreviewed', sourceId: 'community-npm' },
        requestInterceptors: [{ id: 'api', origins: ['https://api.example.com'], methods: ['GET'], priority: 20 }],
        rawCredentialAccess: [{
            accessMode: 'raw',
            contribution: { pluginId: 'acme.example', localId: 'voice' },
            credentialSlot: { id: 'voice_auth', title: 'API key', purpose: 'voice.client-auth' },
            sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
            realm: 'daemon',
            phase: 'connection',
            request: {
                kind: 'httpHeaders',
                origin: 'https://api.example.com',
                headerNames: ['authorization'],
            },
        }],
    });

    it('declines exactly once when the modal provider host unmounts', async () => {
        modalState.show.mockReset();
        let shown: Readonly<{ onRequestClose?: () => void; onHostUnmount?: () => void }> | undefined;
        modalState.show.mockImplementation((config) => {
            shown = config;
            return 'install-review';
        });
        const { showPluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const pending = showPluginInstallationReviewDialog({
            title: 'Review plugin',
            review,
            target: { machine: 'Laptop', server: 'Server A' },
        });

        expect(shown?.onHostUnmount).toEqual(expect.any(Function));
        shown?.onHostUnmount?.();
        shown?.onRequestClose?.();
        await expect(pending).resolves.toEqual({ approved: false, optionalSelections: [] });
    });

    it('names the exact machine and server the install-and-trust decision lands on', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={review}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        // Trust is granted on ONE machine reached through ONE server, so the
        // review must carry that target and not just the package review body.
        expect(screen.findByTestId('settings.plugins.installReview.target')?.props.children)
            .toBe(`settingsPlugins.pluginChangeConfirmTarget:${JSON.stringify({
                machine: 'Build box',
                server: 'Server B',
            })}`);
    });

    it.each([
        ['https://downloads.example.test/plugin.tgz?access_token=example', true],
        ['https://downloads.example.test/plugin.tgz', true],
        ['/tmp/plugin.tgz', false],
    ])('discloses retained archive URL credentials before approval for %s', async (locator, expected) => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    source: { kind: 'archive', locator, integrity: 'sha512-example', integrityBasis: 'observed' },
                    updateChannel: { kind: 'archive', locator },
                })}
                target={{ machine: 'Laptop', server: 'Server A' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        expect(Boolean(screen.findByTestId('settings.plugins.installReview.archiveUrlRetention'))).toBe(expected);
        expect(screen.findByTestId('settings.plugins.installReview.confirm')).toBeTruthy();
    });

    it('renders protocol review facts semantically without certification claims', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const onResolve = vi.fn();
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    ...review,
                    optionalHostAccess: [{
                        id: 'workspace', capability: 'Workspace files', reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection', normalizedScope: { kind: 'workspace' },
                    }],
                })}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={onResolve}
                onClose={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings.plugins.installReview.identity')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.evidence')).toBeNull();
        expect(screen.findByTestId('settings.plugins.installReview.trustedCode')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.executableCode')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.rawCredentials')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.optional.workspace')?.props.value).toBe(false);
        await act(async () => {
            screen.findByTestId('settings.plugins.installReview.optional.workspace')?.props.onValueChange(true);
        });
        expect(screen.findByTestId('settings.plugins.installReview.evidenceToggle')?.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
        await screen.pressByTestIdAsync('settings.plugins.installReview.evidenceToggle');
        expect(screen.findByTestId('settings.plugins.installReview.evidenceToggle')?.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
        expect(screen.findByTestId('settings.plugins.installReview.evidence')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.requestInterceptors')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.rawCredentials')).toBeTruthy();
        expect(JSON.stringify(screen.tree.toJSON()))
            .toContain('settingsPlugins.installReviewSections.runtimeApi');
        expect(JSON.stringify(screen.tree.toJSON())).not.toMatch(/certif/i);
        await screen.pressByTestIdAsync('settings.plugins.installReview.evidenceToggle');
        expect(screen.findByTestId('settings.plugins.installReview.optional.workspace')?.props.value).toBe(true);
        await screen.pressByTestIdAsync('settings.plugins.installReview.confirm');
        expect(onResolve).toHaveBeenCalledWith({ approved: true, optionalSelections: [{ accessId: 'workspace', selected: true }] });
    });

    it('uses navigable headings without merging section facts or optional access controls', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    optionalHostAccess: [{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace' },
                    }],
                })}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const sectionIds = [
            'identity',
            'trustedCode',
            'executableCode',
            'requiredAccess',
            'requestInterceptors',
            'rawCredentials',
        ];
        for (const sectionId of sectionIds) {
            const section = screen.findByTestId(`settings.plugins.installReview.${sectionId}`);
            expect(section?.props.accessible).not.toBe(true);
            expect(section?.props.accessibilityRole).not.toBe('summary');
            expect(section?.findAll((node) => (node.type as unknown) === 'Text' && node.props.accessibilityRole === 'header')).toHaveLength(1);
        }
        expect(screen.findByTestId('settings.plugins.installReview.optionalAccess')
            ?.findAll((node) => (node.type as unknown) === 'Text' && node.props.accessibilityRole === 'header')).toHaveLength(1);
        expect(screen.findByTestId('settings.plugins.installReview.optional.workspace')?.props.accessibilityRole).toBe('switch');

        const orderedFacts = screen.findAll((node) => (node.type as unknown) === 'View' && typeof node.props.testID === 'string')
            .map((node) => node.props.testID)
            .filter((testID) => sectionIds.some((sectionId) => testID === `settings.plugins.installReview.${sectionId}`));
        expect(orderedFacts).toEqual(sectionIds.map((sectionId) => `settings.plugins.installReview.${sectionId}`));
    });

    it('shows only the declared authority categories that expanded during an update', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    requiredHostAccess: [{
                        id: 'network',
                        capability: 'network',
                        reason: 'Connect to the review service',
                        authorizationClass: 'cooperativeDisclosure',
                        normalizedScope: { origin: 'https://review.example.test' },
                    }],
                })}
                reason="authorityExpansion"
                currentVersion="1.0.0"
                authorityExpansion={['requiredHostAccess']}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        expect(screen.findByTestId('settings.plugins.installReview.requiredAccess')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.installReview.trustedCode')).toBeNull();
        expect(screen.findByTestId('settings.plugins.installReview.executableCode')).toBeNull();
        expect(screen.findByTestId('settings.plugins.installReview.requestInterceptors')).toBeNull();
        expect(screen.findByTestId('settings.plugins.installReview.rawCredentials')).toBeNull();
    });

    it('leaves unchanged optional grants untouched in an authority-delta decision', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const onResolve = vi.fn();
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    optionalHostAccess: [{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace' },
                    }],
                })}
                reason="authorityExpansion"
                currentVersion="1.0.0"
                authorityExpansion={['selectedOptionalHostAccess']}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={onResolve}
                onClose={vi.fn()}
            />,
        );

        await screen.pressByTestIdAsync('settings.plugins.installReview.confirm');
        expect(onResolve).toHaveBeenCalledWith({ approved: true, optionalSelections: [] });
    });

    it('shows trusted-code, scope, and credential facts without hardcoded English review vocabulary', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
                    provenance: { status: 'declaredUnverified', predicateType: 'https://slsa.dev/provenance/v1' },
                    curation: { status: 'unreviewed', sourceId: 'community-npm' },
                    optionalHostAccess: [{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace', mode: 'read' },
                    }],
                    rawCredentialAccess: [
                        ...review.rawCredentialAccess,
                        {
                            accessMode: 'raw',
                            contribution: { pluginId: 'acme.example', localId: 'cloud' },
                            credentialSlot: { id: 'cloud_auth', title: 'Cloud account', purpose: 'cloud.sync' },
                            sourceClass: {
                                kind: 'connectedAccount',
                                service: { pluginId: 'acme.accounts', localId: 'cloud' },
                            },
                            realm: 'daemon',
                            phase: 'connection',
                            request: {
                                kind: 'environment',
                                keys: ['ACME_TOKEN'],
                            },
                        },
                    ],
                })}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        await screen.pressByTestIdAsync('settings.plugins.installReview.evidenceToggle');
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('settingsPlugins.installReviewSections.trustedCodeDisclosure');
        expect(rendered).toContain('settingsPlugins.installReviewSections.scope');
        expect(rendered).toContain('workspace');
        expect(rendered).toContain('read');
        expect(rendered).toContain('settingsPlugins.installReviewSections.secretKinds');
        expect(rendered).toContain('apiKey');
        expect(rendered).toContain('settingsPlugins.installReviewSections.connectedAccountService');
        expect(rendered).toContain('acme.accounts/cloud');
        expect(rendered).toContain('settingsPlugins.installReviewSections.credentialPurpose');
        expect(rendered).toContain('cloud.sync');
        expect(rendered).toContain('settingsPlugins.installReviewSections.credentialAccess');
        expect(rendered).toContain('ACME_TOKEN');
        expect(rendered).toContain('settingsPlugins.installReviewSections.runtimeApi');
        expect(rendered).not.toContain('settingsPlugins.updatePolicy.');
        expect(rendered).not.toMatch(/\b(?:declared, unverified|retrieved, unverified|unreviewed|development|runtime API)\b/i);
    });

    it('renders hosted-web execution as its own isolated realm label', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    executableRealms: ['daemon', 'reactNative', 'hostedWeb'],
                })}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const rendered = screen.getTextContent();
        expect(rendered).toContain('settingsPlugins.installReviewSections.executableRealm.daemon');
        expect(rendered).toContain('settingsPlugins.installReviewSections.executableRealm.reactNative');
        expect(rendered).toContain('settingsPlugins.installReviewSections.executableRealm.hostedWeb');
    });

    it('presents host scope and credential materialization as readable facts, not JSON', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    requiredHostAccess: [{
                        id: 'network',
                        capability: 'network',
                        reason: 'Connect to the review service',
                        authorizationClass: 'cooperativeDisclosure',
                        normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://review.example.test' }] },
                    }],
                    optionalHostAccess: [{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace', mode: 'read' },
                    }],
                    rawCredentialAccess: [
                        {
                            accessMode: 'raw',
                            contribution: { pluginId: 'acme.example', localId: 'voice' },
                            credentialSlot: { id: 'voice_auth', title: 'API key', purpose: 'voice.client-auth' },
                            sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
                            realm: 'daemon',
                            phase: 'connection',
                            request: {
                                kind: 'httpHeaders',
                                origin: 'https://api.example.com',
                                headerNames: ['authorization'],
                            },
                        },
                        {
                            accessMode: 'raw',
                            contribution: { pluginId: 'acme.example', localId: 'cloud' },
                            credentialSlot: { id: 'cloud_auth', title: 'Cloud account', purpose: 'cloud.sync' },
                            sourceClass: {
                                kind: 'connectedAccount',
                                service: { pluginId: 'acme.accounts', localId: 'cloud' },
                            },
                            realm: 'daemon',
                            phase: 'connection',
                            request: { kind: 'environment', keys: ['ACME_TOKEN'] },
                        },
                    ],
                })}
                target={{ machine: 'Build box', server: 'Server B' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        // Structured host scope and credential materialization are trust facts
        // a reader must be able to actually read; a serialized JSON blob is
        // not a human-readable disclosure of them.
        const rendered = screen.getTextContent();
        expect(rendered).not.toContain('\\"targets\\"');
        expect(rendered).not.toContain('\\"kind\\"');
        // Declared keys and discriminators read as words; a target led by its kind reads as one line.
        expect(rendered).toContain('settingsPlugins.installReviewSections.networkAccessAnyMethod');
        expect(rendered).toContain('https://review.example.test');
        expect(rendered).not.toContain('Fixed origin');
        expect(rendered).toContain('Workspace · read');
        expect(rendered).not.toContain('fixedOrigin');
        expect(rendered).toContain('settingsPlugins.installReviewSections.credentialRequestHeaders');
        expect(rendered).toContain('https://api.example.com');
        expect(rendered).toContain('authorization');
        expect(rendered).toContain('settingsPlugins.installReviewSections.credentialRequestEnvironment');
        expect(rendered).toContain('ACME_TOKEN');
    });
});
