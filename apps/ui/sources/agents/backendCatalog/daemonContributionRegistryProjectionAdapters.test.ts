import { describe, expect, it, vi } from 'vitest';

import { PluginProjectionV2Schema, type PluginProjectedSettingsV2, type PluginProjectionV2 } from '@happier-dev/protocol';
import { createProjectedAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import * as projectionNormalizer from '@/sync/domains/plugins/ui/projection';
import * as descriptorProjection from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    publishDaemonMergedProjectionInputs,
    mapV2EditableSettingsGroup,
    resolvePluginProjectionEditableSettingsGroup,
} from './daemonContributionRegistryProjectionAdapters';

describe('daemon contribution registry projection adapters', () => {
    it('reuses ready models without deriving again for equivalent newly decoded full replies', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 19 });
        const first = publishDaemonMergedProjectionInputs({ projection });
        const replies = Array.from({ length: 100 }, () => structuredClone(projection));
        const normalize = vi.spyOn(projectionNormalizer, 'normalizePluginUiProjection');
        const parseDescriptors = vi.spyOn(descriptorProjection, 'readConnectedAccountDescriptorProjection');
        try {
            for (const reply of replies) expect(publishDaemonMergedProjectionInputs({ projection: reply }, first)).toBe(first);
            expect(normalize).not.toHaveBeenCalled();
            expect(parseDescriptors).not.toHaveBeenCalled();
        } finally {
            normalize.mockRestore();
            parseDescriptors.mockRestore();
        }
    });

    it('publishes changed translation bundles with canonical immutable ownership for unchanged selected reads', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 20,
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.review': { id: 'translations:acme.review', pluginId: 'acme.review', occurrenceId: 'review-current',
                    contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Review' } } },
            } } },
        });
        const first = publishDaemonMergedProjectionInputs({ projection });
        const changed = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({
            ...projection, familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                ...projection.familiesById.pluginUi?.entriesById,
                'translations:acme.review': { ...projection.familiesById.pluginUi?.entriesById['translations:acme.review'],
                    bundles: { en: { title: 'Changed' } } },
            } } },
        }) }, first);
        const bundles = changed.pluginUiProjection.translationsByPluginId['acme.review']?.bundles;
        expect(bundles).toEqual({ en: { title: 'Changed' } });
        expect(projectNativeJsonValueForTransport(bundles)).toBe(bundles);
    });

    it('retains unchanged ready maps when a projection without pluginUi changes only delivery generation', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 20,
            actionsById: { 'acme.review/refresh': { id: 'refresh', pluginId: 'acme.review', occurrenceId: 'review-current',
                title: 'Refresh', scopes: ['session'], surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'writesRemote' } },
        });
        const first = publishDaemonMergedProjectionInputs({ projection });
        const changed = publishDaemonMergedProjectionInputs({ projection: { ...projection, generation: 21 } }, first);
        expect(changed.pluginUiProjection.generation).toBe(21);
        expect(changed.pluginUiProjection.actionsById).toBe(first.pluginUiProjection.actionsById);
        expect(changed.pluginUiProjection.composerAttachmentsById).toBe(first.pluginUiProjection.composerAttachmentsById);
    });

    it('owns immutable adapted rows without freezing or retaining aliases to the raw V2 input', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 19,
            agentsById: { review: { id: 'review', title: 'Review', identity: { pluginId: 'acme.review', localId: 'review' },
                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'acme.review', localId: 'account' }, credentialKinds: ['oauth'] }],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true,
                source: { kind: 'local', locator: '/plugins/review' } } },
            actionsById: { 'acme.review/refresh': { id: 'refresh', pluginId: 'acme.review', occurrenceId: 'review-current',
                title: 'Refresh', scopes: ['session'], surfaces: ['plugin'], execution: { target: 'daemon' }, dangerLevel: 'writesRemote',
                inputHints: { title: 'Refresh', submitLabel: 'Refresh', fields: [{ path: 'reason', title: 'Reason', widget: 'textarea', required: true }] } } },
        });
        const published = publishDaemonMergedProjectionInputs({ projection });
        const purposes = published.mergedProviderProjectionById.review!.connectedAccounts!;
        expect(Object.isFrozen(purposes)).toBe(true);
        expect(Object.isFrozen(purposes[0]!.service)).toBe(true);
        expect(Reflect.set(projection.agentsById.review!.connectedAccounts![0]!, 'purpose', 'changed')).toBe(true);
        expect(purposes[0]!.purpose).toBe('primary');
        const row = published.pluginProjectionById['acme.review']!;
        const hint = projection.actionsById['acme.review/refresh']!.inputHints?.fields?.[0];
        if (!hint) throw new Error('Expected authored form field');
        expect(published.pluginProjectionV2).toBe(projection);
        expect(Reflect.set(projection.installedPackagesById['acme.review']!.source, 'locator', '/plugins/changed')).toBe(true);
        expect(Reflect.set(hint, 'title', 'Changed')).toBe(true);
        expect(row.installedPackage?.source.locator).toBe('/plugins/review');
        expect(row.actions[0]?.localizedPresentation?.inputHints?.fields?.[0]?.title).toBe('Reason');
        expect(Object.isFrozen(row)).toBe(true);
        expect(Object.isFrozen(row.actions)).toBe(true);
        expect(Object.isFrozen(row.actions[0]?.localizedPresentation?.inputHints?.fields?.[0])).toBe(true);
        const changed = publishDaemonMergedProjectionInputs({ projection }, published);
        expect(changed.mergedProviderProjectionById.review!.connectedAccounts![0]!.purpose).toBe('changed');
        expect(changed).not.toBe(published);
        expect(changed.pluginProjectionV2).toBe(projection);
        expect(changed.pluginProjectionById['acme.review']?.installedPackage?.source.locator).toBe('/plugins/changed');
        expect(changed.pluginProjectionById['acme.review']?.actions[0]?.localizedPresentation?.inputHints?.fields?.[0]?.title).toBe('Changed');
        expect(row.installedPackage?.source.locator).toBe('/plugins/review');
    });

    it('keeps same-generation selected replies response-local instead of borrowing omitted full-projection rows', () => {
        const full = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({
            v: 2, generation: 17,
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                'translations:acme.review': { id: 'translations:acme.review', pluginId: 'acme.review',
                    occurrenceId: 'review-occurrence',
                    contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Review' } } },
            } } },
        }) });
        const selectedProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 17 });
        const selected = publishDaemonMergedProjectionInputs({ projection: selectedProjection }, full);
        expect(selected.pluginProjectionV2).toBe(selectedProjection);
        expect(selected.pluginUiProjection.translationsByPluginId).toEqual({});
        expect(full.pluginUiProjection.translationsByPluginId['acme.review']).toBeDefined();
        expect(selected.pluginUiProjection).not.toBe(full.pluginUiProjection);
    });

    it('retains pathless contextual Resources without turning their ids into filenames', () => {
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'acme.review': { id: 'acme.review', displayName: 'Review', enabled: true,
                source: { kind: 'local', locator: '/plugins/review' } } }, resourcesById: {
            'acme.review/live-status': { id: 'live-status', pluginId: 'acme.review', resourceKind: 'config',
                scope: 'session', contentType: 'application/json' },
        } });
        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.pluginProjectionById['acme.review']?.resources).toEqual([
            { id: 'live-status', resourceKind: 'config', scope: 'session', digest: null, contentType: 'application/json' },
        ]);
    });
    it('resolves every localized Settings label through the shared plugin text owner', () => {
        const settings: PluginProjectedSettingsV2 = {
            id: 'acme.review.settings',
            pluginId: 'acme.review',
            version: 1,
            title: { key: 'settings.title', fallback: 'Review settings' },
            description: { key: 'settings.description', fallback: 'Configure review' },
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields: [{
                id: 'enabled',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'boolean' },
                valueType: 'boolean',
                control: 'switch',
                secretCustody: null,
                displayKey: { key: 'settings.enabled', fallback: 'Enabled' },
                descriptionKey: { key: 'settings.enabled.description', fallback: 'Use review' },
                redaction: 'none',
                clearWhenEmpty: 'persist',
                capabilityGates: [],
                permissionGates: [],
            }],
        };
        const seen: unknown[] = [];

        const resolved = resolvePluginProjectionEditableSettingsGroup(
            mapV2EditableSettingsGroup(settings),
            (pluginId, value) => {
                seen.push([pluginId, value]);
                return typeof value === 'string' ? value : `localized:${value.key}`;
            },
        );

        expect(resolved).toMatchObject({
            title: 'localized:settings.title',
            description: 'localized:settings.description',
            fields: [{
                title: 'localized:settings.enabled',
                subtitle: 'localized:settings.enabled.description',
            }],
        });
        expect(seen).toHaveLength(4);
    });

    it('preserves projected secret custody for the Settings presentation dispatcher', () => {
        const settings: PluginProjectedSettingsV2 = {
            id: 'acme.review.settings',
            pluginId: 'acme.review',
            version: 1,
            title: 'Review settings',
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields: [{
                id: 'machine-only-token',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                valueType: 'string',
                control: 'password',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
                displayKey: 'Machine-only token',
                redaction: 'secret',
                clearWhenEmpty: 'omit',
                capabilityGates: [],
                permissionGates: [],
            }],
        };

        expect(mapV2EditableSettingsGroup(settings).fields).toEqual([
            expect.objectContaining({
                key: 'machine-only-token',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'serverBaseUrl' },
            }),
        ]);
    });

    it('adapts plugin projection v2 registry metadata', () => {
        const authorization: NonNullable<
            PluginProjectionV2['actionsById'][string]['authorization']
        > = {
            generation: {
                targetGeneration: 'generation-42',
                desiredGeneration: 'generation-42',
                appliedGeneration: 'generation-42',
                targetGenerationMode: 'current',
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        };
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'acme.review': {
                    id: 'acme.review',
                    displayName: 'Acme Review',
                    version: '1.2.3',
                    enabled: true,
                    immutableGenerationId: 'generation-42',
                    occurrenceId: 'acme-review-occurrence-42',
                    source: {
                        kind: 'localPath',
                        locator: '/plugins/acme-review',
                    },
                    brand: {
                        state: 'available',
                        resource: { pluginId: 'acme.review', localId: 'brand' },
                        width: 128,
                        height: 128,
                        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                },
            },
            agentsById: {
                'acme.native': {
                    id: 'acme.native',
                    identity: {
                        pluginId: 'acme.review',
                        localId: 'acme-native',
                    },
                    iconAgentId: 'claude',
                    channel: 'plugin',
                    isBuiltIn: false,
                    connectedAccounts: [{
                        purpose: 'primary',
                        service: { pluginId: 'acme.review', localId: 'account' },
                        required: false,
                    }],
                    providerOwnedEnvironmentKeys: [],
                    cli: {
                        executable: { binaryName: 'acme', sourcePreference: 'system-first' },
                        install: { manual: { kind: 'none' } },
                        auth: {
                            support: 'login_terminal',
                            loginLaunches: [
                                { kind: 'primary', args: ['login'] },
                                { kind: 'device_code', args: ['login', '--device-code'] },
                            ],
                        },
                    },
                },
            },
            actionsById: {
                'acme.review.refresh': {
                    id: 'acme.review.refresh',
                    pluginId: 'acme.review',
                    occurrenceId: 'acme-review-occurrence-42',
                    title: 'Refresh Acme',
                    description: 'Refresh Acme resources',
                    scopes: ['settings'],
                    surfaces: ['agent'],
                    execution: { target: 'daemon' },
                    placementBindings: ['detailsPanel'],
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                    authorization,
                    available: true,
                },
                'acme.review.refresh-provider-state': {
                    id: 'acme.review.refresh-provider-state',
                    pluginId: 'acme.review',
                    occurrenceId: 'acme-review-occurrence-42',
                    title: 'Refresh provider state',
                    scopes: ['session'],
                    surfaces: ['plugin'],
                    execution: { target: 'daemon' },
                    dangerLevel: 'writesRemote',
                },
            },
            familiesById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {
                'acme.review.prompt': {
                    id: 'acme.review.prompt',
                    pluginId: 'acme.review',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
                'acme.review/live-status': {
                    id: 'live-status', pluginId: 'acme.review', resourceKind: 'config',
                    scope: 'session', contentType: 'application/json',
                },
            },
            settingsById: {
                'acme.review.settings': {
                    id: 'settings',
                    pluginId: 'acme.review',
                    version: 1,
                    title: 'Review settings',
                    scope: { kind: 'daemon' },
                    presentation: { sections: [], subagentSections: [] },
                    target: { kind: 'plugin' },
                    fields: [],
                },
            },
            diagnostics: [
                {
                    version: 1,
                    id: 'acme.review:normalization:plugin:0',
                    data: {
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'normalization',
                    occurrenceId: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 1,
                    resolution: { state: 'current' },
                },
                {
                    version: 1,
                    id: 'acme.review:activation:plugin:0',
                    data: {
                        severity: 'info',
                        code: 'plugin.activated',
                        message: 'Activation completed',
                    },
                    plugin: { id: 'acme.review', version: '1.2.3', source: 'localPath' },
                    stage: 'activation',
                    occurrenceId: '42',
                    host: 'daemon',
                    platform: 'darwin',
                    occurredAtMs: 2,
                    resolution: { state: 'current' },
                },
            ],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.mergedProviderProjectionById['acme.native']?.identity).toEqual({
            pluginId: 'acme.review',
            localId: 'acme-native',
        });
        expect(adapted.mergedProviderProjectionById['acme.native']).toEqual(expect.objectContaining({
            qualifiedId: 'acme.native',
            projectionGeneration: 42,
            installedPackage: expect.objectContaining({
                id: 'acme.review',
                immutableGenerationId: 'generation-42',
                brand: expect.objectContaining({ state: 'available' }),
            }),
        }));

        expect(adapted.mergedProviderProjectionById['acme.native']?.cli?.auth.loginLaunches).toEqual([
            { kind: 'primary', args: ['login'] },
            { kind: 'device_code', args: ['login', '--device-code'] },
        ]);
        expect(adapted.mergedProviderProjectionById['acme.native']?.connectedAccounts).toEqual([{
            purpose: 'primary',
            service: { pluginId: 'acme.review', localId: 'account' },
            required: false,
        }]);
        const projectedCli = adapted.mergedProviderProjectionById['acme.native']?.cli;
        if (!projectedCli) throw new Error('expected native Agent CLI/auth projection');
        const authPlugin = createProjectedAgentLocalAuthPlugin({
            agentId: 'acme.native',
            cli: projectedCli,
        });
        expect(authPlugin.loginLaunchKinds).toEqual(['primary', 'device_code']);
        expect(authPlugin.buildLoginLaunch?.({
            kind: 'device_code',
            resolvedCommand: "'/opt/runtime/bun' '/opt/acme/acme.js'",
        })).toEqual({
            launch: { kind: 'agent_login', agentId: 'acme.native', launchId: 'device_code' },
        });

        // The plugin shows the mark of the Agent it contributes, rather than a letter.
        expect(adapted.pluginProjectionById?.['acme.review']?.iconAgentId).toBe('claude');
        expect(adapted.pluginProjectionById?.['acme.review']).toEqual(expect.objectContaining({
            pluginId: 'acme.review',
            occurrenceId: 'acme-review-occurrence-42',
            title: 'Acme Review',
            version: '1.2.3',
            enabled: true,
            generation: 42,
            generationLabel: '42',
            provenance: expect.objectContaining({
                sourceKind: 'localPath',
                sourceLabel: '/plugins/acme-review',
            }),
            diagnostics: [
                { code: 'registry.warning', message: 'Registry rebuilt with warnings', severity: 'warning' },
                { code: 'plugin.activated', message: 'Activation completed', severity: 'info' },
            ],
            actions: [
                expect.objectContaining({
                    id: 'acme.review.refresh',
                    title: 'Refresh Acme',
                    inputHints: {
                        title: 'Refresh Acme',
                        submitLabel: 'Refresh',
                        fields: [{
                            path: 'reason',
                            title: 'Reason',
                            widget: 'textarea',
                            required: true,
                        }],
                    },
                    dangerLevel: 'writesRemote',
                    confirmation: {
                        title: { key: 'actions.refresh.title', fallback: 'Refresh remote resources?' },
                        body: { key: 'actions.refresh.body', fallback: 'This changes remote resources.' },
                        confirmLabel: { key: 'actions.refresh.confirm', fallback: 'Refresh' },
                    },
                    authorization,
                }),
                expect.objectContaining({
                    id: 'acme.review.refresh-provider-state',
                    placementBindings: [],
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'acme.review.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                }),
                expect.objectContaining({ id: 'live-status', resourceKind: 'config', scope: 'session' }),
            ],
            editableSettingsGroups: [
                expect.objectContaining({
                    id: 'settings',
                    scope: { kind: 'daemon' },
                }),
            ],
        }));
        expect(adapted.registryDiagnostics).toEqual([]);
        // Action schemas are read lazily through the daemon action-schema endpoint.
        expect(adapted.pluginProjectionById['acme.review']?.actions.find(action => action.id === 'acme.review.refresh-provider-state')).not.toHaveProperty('inputSchema');
        expect(adapted.pluginProjectionById['acme.review']?.resources.find(resource => resource.id === 'live-status')).not.toHaveProperty('path');
    });

    it('gives a bundled Agent plugin the mark of the Agent it is, as the Agent picker does', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 7,
            installedPackagesById: {
                'happier.claude': {
                    id: 'happier.claude',
                    displayName: 'Claude',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.claude' },
                },
                'acme.fork': {
                    id: 'acme.fork',
                    displayName: 'Fork',
                    version: '1.0.0',
                    enabled: true,
                    source: { kind: 'npm', locator: 'acme-fork' },
                },
            },
            agentsById: {
                // A bundled Agent names no separate icon: it is the Claude Agent.
                claude: {
                    id: 'claude',
                    identity: { pluginId: 'happier.claude', localId: 'claude' },
                    channel: 'stable',
                    isBuiltIn: true,
                    providerOwnedEnvironmentKeys: [],
                },
                // An Agent that names its icon wears that icon, ahead of the catalog Agent it runs as.
                'acme.fork/fork': {
                    id: 'acme.fork/fork',
                    identity: { pluginId: 'acme.fork', localId: 'fork' },
                    channel: 'stable',
                    isBuiltIn: false,
                    iconAgentId: 'claude',
                    catalogAgentId: 'codex',
                    providerOwnedEnvironmentKeys: [],
                },
            } as unknown as PluginProjectionV2['agentsById'],
            actionsById: {},
            familiesById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById['happier.claude']?.iconAgentId).toBe('claude');
        expect(adapted.pluginProjectionById['acme.fork']?.iconAgentId).toBe('claude');
    });

    it('says what kinds of things each plugin contributes, from its Agents and contribution families', () => {
        const pkg = (id: string) => ({ id, displayName: id, version: '1.0.0', enabled: true, source: { kind: 'bundled', locator: id } });
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 1,
            installedPackagesById: {
                'happier.claude': pkg('happier.claude'),
                'happier.github': pkg('happier.github'),
                'happier.elevenlabs': pkg('happier.elevenlabs'),
                'happier.empty': pkg('happier.empty'),
            },
            agentsById: {
                claude: { id: 'claude', identity: { pluginId: 'happier.claude', localId: 'claude' }, channel: 'stable', isBuiltIn: true, providerOwnedEnvironmentKeys: [] },
            } as unknown as PluginProjectionV2['agentsById'],
            actionsById: {},
            familiesById: {
                scmHostingProviders: { family: 'scmHostingProviders', entriesById: { github: { id: 'github', pluginId: 'happier.github' } } },
                voiceProviders: { family: 'voiceProviders', entriesById: { el: { id: 'el', pluginId: 'happier.elevenlabs' } } },
                providers: { family: 'providers', entriesById: { claudeModels: { id: 'claudeModels', pluginId: 'happier.claude' } } },
            } as unknown as PluginProjectionV2['familiesById'],
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        // An Agent comes first: it is what the plugin is for.
        expect(adapted.pluginProjectionById['happier.claude']?.contributionKinds).toEqual(['agent', 'providers']);
        expect(adapted.pluginProjectionById['happier.github']?.contributionKinds).toEqual(['scmHostingProviders']);
        expect(adapted.pluginProjectionById['happier.elevenlabs']?.contributionKinds).toEqual(['voiceProviders']);
        expect(adapted.pluginProjectionById['happier.empty']?.contributionKinds).toEqual([]);
    });

    it('keeps a target semantic diagnostic on the target Settings entry', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'happier.channels': {
                    id: 'happier.channels',
                    displayName: 'Channels',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channels' },
                },
                'happier.channel.telegram': {
                    id: 'happier.channel.telegram',
                    displayName: 'Telegram',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.channel.telegram' },
                },
                'happier.scm.forge.github': {
                    id: 'happier.scm.forge.github',
                    displayName: 'GitHub',
                    version: '0.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'happier.scm.forge.github' },
                },
            },
            agentsById: {},
            actionsById: {},
            familiesById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [{
                version: 1,
                id: 'happier.channels:runtime:happier.channels/providers:0',
                data: {
                    severity: 'error',
                    code: 'target_semantics_unavailable',
                    message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
                    details: {
                        target: { pluginId: 'happier.channels', pointId: 'providers' },
                        contributor: { pluginId: 'happier.channel.telegram', contributionId: 'telegram' },
                        protocol: { id: 'happier.channels/providers', version: 1 },
                        reason: 'target_semantics_unavailable',
                    },
                },
                plugin: { id: 'happier.channels', version: '0.0.0', source: 'bundled' },
                contribution: { pluginId: 'happier.channels', localId: 'providers' },
                stage: 'runtime',
                occurrenceId: 'channels-occurrence-a',
                host: 'daemon',
                platform: 'test',
                occurredAtMs: 1,
                resolution: { state: 'current' },
            }],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById['happier.channels']?.diagnostics).toEqual([{
            code: 'target_semantics_unavailable',
            message: 'Targeted contribution semantics rejected (target_semantics_unavailable).',
            severity: 'error',
            details: {
                target: { pluginId: 'happier.channels', pointId: 'providers' },
                contributor: { pluginId: 'happier.channel.telegram', contributionId: 'telegram' },
                protocol: { id: 'happier.channels/providers', version: 1 },
                reason: 'target_semantics_unavailable',
            },
            contribution: { pluginId: 'happier.channels', localId: 'providers' },
        }]);
        expect(adapted.pluginProjectionById['happier.channel.telegram']?.diagnostics).toEqual([]);
        expect(adapted.pluginProjectionById['happier.scm.forge.github']?.diagnostics).toEqual([]);
    });

});
