import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerSurfaceMountBindingV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { DaemonPluginUiComposerSurfaceCatalogEntryV1Schema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { ComposerPluginSurface } = await import('./ComposerPluginSurface');
const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
const { createComposerPresentationTransactionApplier } = await import('./sessionComposerPresentationTargets');
afterEach(() => vi.restoreAllMocks());

it('does not revalidate an unchanged Composer mount on an unrelated parent render', async () => {
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 7, familiesById: {} });
    const entry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
        contribution: { pluginId: 'acme.compose', localId: 'summary' },
        occurrenceId: 'generation-1', projectionGeneration: 7, role: 'region',
        rendererChain: [{ pluginId: 'acme.compose', localId: 'summary-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.compose', localId: 'summary-renderer' },
            renderer: { kind: 'declarative', contributionId: 'summary-renderer' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: { serverIdentityId: 'srv_server-1', materializationRef: {
            machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.compose',
        } },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.compose', occurrenceId: 'generation-1',
                sourceCustody: { kind: 'development', registeredRootId: 'compose-root' } },
            points: [],
        },
    });
    const inputs = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [entry] });
    const catalogEntries = inputs.composerSurfaceCatalog!;
    const transactionApplier = createComposerPresentationTransactionApplier({ composerAttachmentsById: {} });
    // Retired parents render no plugin leaf. The real host, catalog and parser stay
    // loaded; this isolates host validation cost without replacing internal logic.
    const parentLifetime = { isCurrent: () => false, onRetire: () => ({ dispose() {} }) };
    const render = (instanceId = 'new-session-1', generation = 7, entries = catalogEntries) => <ComposerPluginSurface
        request={{ contribution: entry.contribution, occurrenceId: 'generation-1', role: 'region',
            input: { v: 1, role: 'region', composer: { kind: 'newSession', instanceId }, regionLocalId: 'summary' },
            instanceKey: 'composer:region:acme.compose/summary' }}
        physicalTarget={{ kind: 'app' }} projectionGeneration={generation} catalogEntries={entries}
        pluginProjectionById={inputs.pluginProjectionById} pluginProjectionV2={projection}
        pluginUiProjection={inputs.pluginUiProjection} actionInputSelectionFacts={inputs.composerSurfaceActionInputSelectionFacts}
        machineId="machine-1" serverId="server-1" parentLifetime={parentLifetime} transactionApplier={transactionApplier}
    />;
    // Call-through measurement: the strict schema still validates every changed input.
    const validation = vi.spyOn(ComposerSurfaceMountBindingV1Schema, 'safeParse');
    const screen = await renderScreen(render());
    try {
        const initialValidations = validation.mock.calls.length;
        expect(initialValidations).toBeGreaterThan(0);
        await screen.update(render());
        expect(validation.mock.calls.length).toBe(initialValidations);
        await screen.update(render('new-session-2'));
        expect(validation.mock.calls.length).toBeGreaterThan(initialValidations);
        const afterInputChange = validation.mock.calls.length;
        await screen.update(render('new-session-2', 8));
        // A stale generation fails before validation, rather than lending the
        // previous admitted mount to a new catalog generation.
        expect(validation.mock.calls.length).toBe(afterInputChange);
        const replacement = publishDaemonMergedProjectionInputs({ projection, composerSurfaceCatalog: [entry] });
        await screen.update(render('new-session-2', 7, replacement.composerSurfaceCatalog!));
        expect(validation.mock.calls.length).toBeGreaterThan(afterInputChange);
    } finally { await screen.unmount(); }
});
