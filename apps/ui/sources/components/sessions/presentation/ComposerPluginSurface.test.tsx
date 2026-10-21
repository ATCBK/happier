import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
} from '@happier-dev/protocol';
import {
    DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
    PluginProjectionV2Schema,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createComposerPresentationTransactionApplier } from './sessionComposerPresentationTargets';

const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
    });
});

vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));

function createCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
        contribution: { pluginId: 'acme.compose', localId: 'summary' },
        occurrenceId: 'generation-1',
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'summary-renderer',
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.compose',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: {
                pluginId: 'acme.compose',
                occurrenceId: 'generation-1',
                sourceCustody: { kind: 'development', registeredRootId: 'compose-root' },
            },
            points: [],
        },
    });
}

function createProjection(generation: number) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation,
        familiesById: {},
    });
}

const transactionApplier = createComposerPresentationTransactionApplier({
    composerAttachmentsById: {},
});

const lifetime = {
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
};

describe('ComposerPluginSurface', () => {
    it('reuses the one PluginSurfaceHost composer arm with the supplied truthful target', async () => {
        const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
        const catalogEntry = createCatalogEntry();
        const fallback = React.createElement('FallbackBadge', { testID: 'canonical-composer-badge' });
        const projection = createProjection(7);
        const { pluginUiProjection } = publishDaemonMergedProjectionInputs({ projection });

        await renderScreen(<ComposerPluginSurface
            request={{
                contribution: catalogEntry.contribution,
                occurrenceId: 'generation-1',
                role: 'region',
                input: {
                    v: 1,
                    role: 'region',
                    composer: { kind: 'newSession', instanceId: 'new-session-1' },
                    regionLocalId: 'summary',
                },
                instanceKey: 'composer:region:acme.compose/summary',
            }}
            physicalTarget={{ kind: 'app' }}
            projectionGeneration={7}
            catalogEntries={[catalogEntry]}
            pluginProjectionById={{}}
            pluginProjectionV2={projection}
            pluginUiProjection={pluginUiProjection}
            machineId="machine-1"
            serverId="server-1"
            parentLifetime={lifetime}
            transactionApplier={transactionApplier}
            fallback={fallback}
        />);

        expect(pluginSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            composerMount: expect.objectContaining({
                fallback,
                physicalTarget: { kind: 'app' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'region',
                        input: expect.objectContaining({
                            composer: { kind: 'newSession', instanceId: 'new-session-1' },
                        }),
                    }),
                }),
            }),
        }));
        const hostProps = pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
            composerMount?: Readonly<{
                binding?: Readonly<{
                    mountedHostApiHandlers?: Readonly<Record<string, unknown>>;
                }>;
            }>;
        }>;
        expect(hostProps.composerMount?.binding?.mountedHostApiHandlers).toEqual(expect.objectContaining({
            pickComposerMedia: expect.any(Function),
            inspectComposerContent: expect.any(Function),
            releaseComposerContent: expect.any(Function),
        }));
    });

    it('passes the existing mount/catalog identity to the host for boundary recovery', async () => {
        const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
        const renderComposer = (occurrenceId: string, projectionGeneration: number) => {
            const projection = createProjection(projectionGeneration);
            const { pluginUiProjection } = publishDaemonMergedProjectionInputs({ projection });
            const catalogEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
                ...createCatalogEntry(),
                occurrenceId,
                projectionGeneration,
                contributorTargetedContributions: {
                    target: {
                        pluginId: 'acme.compose',
                        occurrenceId,
                        sourceCustody: { kind: 'development', registeredRootId: 'compose-root' },
                    },
                    points: [],
                },
            });
            return (
                <ComposerPluginSurface
                    request={{
                        contribution: catalogEntry.contribution,
                        occurrenceId,
                        role: 'region',
                        input: {
                            v: 1,
                            role: 'region',
                            composer: { kind: 'newSession', instanceId: 'new-session-1' },
                            regionLocalId: 'summary',
                        },
                        instanceKey: 'composer:region:acme.compose/summary',
                    }}
                    physicalTarget={{ kind: 'app' }}
                    projectionGeneration={projectionGeneration}
                    catalogEntries={[catalogEntry]}
                    pluginProjectionById={{}}
                    pluginProjectionV2={projection}
                    pluginUiProjection={pluginUiProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    parentLifetime={lifetime}
                    transactionApplier={transactionApplier}
                />
            );
        };
        const readBoundaryResetKey = (): unknown => (
            (pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{
                composerMount?: Readonly<{ boundaryResetKey?: unknown }>;
            }>)?.composerMount?.boundaryResetKey
        );

        const screen = await renderScreen(renderComposer('generation-a', 7));
        const initialBoundaryResetKey = readBoundaryResetKey();
        expect(initialBoundaryResetKey).toBeDefined();

        await screen.update(renderComposer('generation-a', 7));
        expect(readBoundaryResetKey()).toBe(initialBoundaryResetKey);

        await screen.update(renderComposer('generation-b', 8));
        expect(readBoundaryResetKey()).not.toBe(initialBoundaryResetKey);
    });

    // The Composer host is presented by the same web bundle in a plain browser
    // tab and inside the Tauri/Electron desktop shell, where `Platform.OS` is
    // still `'web'`. Only the canonical desktop-aware resolver separates them,
    // and the separation decides whether a hosted Composer surface reaches the
    // native desktop Artifact path or the sandboxed browser iframe.
    it('classifies the desktop shell as desktop and a plain browser tab as web', async () => {
        const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
        const catalogEntry = createCatalogEntry();
        const projection = createProjection(7);
        const { pluginUiProjection } = publishDaemonMergedProjectionInputs({ projection });
        const renderComposerSurface = () => renderScreen(<ComposerPluginSurface
            request={{
                contribution: catalogEntry.contribution,
                occurrenceId: 'generation-1',
                role: 'region',
                input: {
                    v: 1,
                    role: 'region',
                    composer: { kind: 'newSession', instanceId: 'new-session-1' },
                    regionLocalId: 'summary',
                },
                instanceKey: 'composer:region:acme.compose/summary',
            }}
            physicalTarget={{ kind: 'app' }}
            projectionGeneration={7}
            catalogEntries={[catalogEntry]}
            pluginProjectionById={{}}
            pluginProjectionV2={projection}
            pluginUiProjection={pluginUiProjection}
            machineId="machine-1"
            serverId="server-1"
            parentLifetime={lifetime}
            transactionApplier={transactionApplier}
        />);
        const readPlatform = (): unknown => (
            (pluginSurfaceHostSpy.mock.calls.at(-1)?.[0] as Readonly<{ platform?: unknown }>)?.platform
        );

        await renderComposerSurface();
        expect(readPlatform()).toBe('web');

        (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            await renderComposerSurface();
            expect(readPlatform()).toBe('desktop');
        } finally {
            delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
        }
    });
});
