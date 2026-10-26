import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
// These runtime barrels load RPC clients; the incumbent pane harness installs Socket first.
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
await loadSyncSingletonForTests();
const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'workspace-browser',
    scopeId: 'project:wr_1',
    features: () => createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, viewTargets: { enabled: true } } } }),
    rpc: async () => { throw new RpcError('Unsupported fixture RPC', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE); },
});

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-1',
        updatedAt: 3_000,
        targets: [{
            id: 'preview:project-browser-feed',
            // A Service row is running only from observed liveness: the daemon's scan saw this listener.
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'project-browser-feed' },
            machineId: 'machine-1',
            title: 'Project browser feed',
            subtitle: 'localhost:3000',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-project-browser-feed',
                sessionId: 'session-project',
                machineId: 'machine-1',
            },
        }],
    });
}

const hostedPluginProjection = {
    ...EMPTY_PLUGIN_BROWSER_PROJECTION,
    generation: 4,
    targetsById: {
        'browserTarget:acme.preview:pane': {
            id: 'browserTarget:acme.preview:pane',
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            contributionId: 'pane',
            target: {
                kind: 'hostedPluginWeb',
                targetId: 'plugin_pane',
                pluginId: 'acme.preview',
                contributionId: 'pane',
                display: {
                    title: 'Plugin Preview',
                    addressLabel: 'plugin://acme.preview/pane',
                },
            },
            display: {
                title: 'Plugin Preview',
                addressLabel: 'plugin://acme.preview/pane',
            },
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            endpointExpiresAt: 1_700_000_000_000,
        },
    },
} satisfies PluginBrowserProjectionModel;


describe('WorkspaceDetailsPanel local service launcher handoff', () => {
    it.each([false, true])('renders supplied launcher rows through the presented Browser leaf (plugin targets: %s)', async withPlugin => {
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1' })]);
        const screen = await renderScreen(<runtime.Wrapper>
            <WorkspaceDetailsPanel
                workspaceRef={{ id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo/main', createdAtMs: 1 }}
                scopeId="project:wr_1"
                localServiceLauncherState={buildLauncherState()}
                pluginBrowserProjection={withPlugin ? hostedPluginProjection : null}
                nowMs={() => 1_500}
            />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' }));
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Project browser feed');
        if (withPlugin) expect(screen.getTextContent()).toContain('Plugin Preview');
        await screen.unmount();
    });
});
