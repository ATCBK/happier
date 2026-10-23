import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createSessionFixture, createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
// Cold Sync transformation belongs to collection, not the Account restore hook's deadline.
await loadSyncSingletonForTests();
const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
const serviceMethods: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-a', rpc: async (method, _input, machineId) => {
    if (method.includes('localServices.')) serviceMethods.push(method);
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return {
        protocolVersion: 1, snapshot: { v: 1, machineId, sessionId: 'session-a', updatedAt: 3_000, targets: [] },
    };
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT) return {
        protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 3_000, refreshState: 'idle', entries: [], diagnostics: [] },
    };
    throw new RpcError('Unsupported fixture RPC', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
} });
beforeEach(() => { serviceMethods.length = 0; });

describe('SessionDetailsPanel local service launcher handoff', () => {
    it.each(['session', 'workspace'] as const)('keeps Local-services reads and watches closed for a file-only %s Details owner', async owner => {
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a' })]);
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, machineId: 'machine-a' } }]);
        const screen = await renderScreen(<runtime.Wrapper>{owner === 'session'
            ? <SessionDetailsPanel sessionId="session-a" routeServerId={runtime.serverId} scopeId="session:session-a" />
            : <WorkspaceDetailsPanel workspaceRef={{ id: 'workspace-a', serverId: runtime.serverId, machineId: 'machine-a',
                rootPath: '/repo', createdAtMs: 1 }} scopeId="session:session-a" />}</runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a.txt', kind: 'file', title: 'a.txt',
            resource: { kind: 'file', path: 'a.txt' } }, { intent: 'pinned' }));
        await flushHookEffects();
        expect(serviceMethods).toEqual([]);

        const browser = createBrowserLaunchpadDetailsTab();
        await act(async () => runtime.pane.openDetailsTab(browser, { intent: 'pinned' }));
        await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(1);
        expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)).toHaveLength(1);
        await act(async () => runtime.pane.setActiveDetailsTab('file:a.txt'));
        await flushHookEffects();
        const hiddenMethods = [...serviceMethods];
        await flushHookEffects();
        expect(serviceMethods).toEqual(hiddenMethods);
        await act(async () => runtime.pane.setActiveDetailsTab(browser.key));
        await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(2);
        expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)).toHaveLength(2);
        await screen.unmount();
    });
    it('passes supplied LSV launcher rows into the real browser details renderer', async () => {
        const { DetailsSurfaceHost, createDetailsSurfaceDescriptor } = await import('@/components/appShell/panes/details/surfaces');
        const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
        const { BrowserDetailsSurface, createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, machineId: 'machine-a' } }]);
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 3_000,
            targets: [{
                id: 'preview:session-browser-feed', source: 'registered_preview',
                machineId: 'machine-a', sessionId: 'session-a', title: 'Session browser feed',
                subtitle: 'localhost:5173', confidence: 'high', state: 'available', actions: [],
                browserTarget: {
                    kind: 'localServicePreview', targetId: 'preview-session-browser-feed',
                    sessionId: 'session-a', machineId: 'machine-a',
                },
            }],
        });
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="session-a" routeServerId={runtime.serverId}
                scopeId="session:session-a" nowMs={() => 4_000} localServiceLauncherState={launcherState} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'unsupported:launcher-probe', kind: 'unsupported', title: 'Launcher probe',
            resource: { kind: 'unsupported' },
        }, { intent: 'pinned' }));
        const host = screen.tree.findByType(DetailsSurfaceHost);
        const tab = { ...createBrowserLaunchpadDetailsTab(), isPinned: true, isPreview: false };
        const descriptor = createDetailsSurfaceDescriptor({ tab, scope: host.props.scope, region: 'details' });
        const browserRenderer = host.props.renderers.find((renderer: { id: string }) => renderer.id === 'browser-view-details-surface');
        expect(browserRenderer).toBeDefined();
        const element = browserRenderer.render({
            tab, descriptor, scope: host.props.scope, region: 'details', active: true, callbacks: host.props.callbacks,
        });
        expect(React.isValidElement(element)).toBe(true);
        if (!React.isValidElement<React.ComponentProps<typeof BrowserDetailsSurface>>(element)) {
            throw new Error('Expected the real browser details surface');
        }
        expect(element.type).toBe(BrowserDetailsSurface);
        expect(element.props.launchpadRows).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'service:preview:session-browser-feed', disabledReason: null }),
        ]));
    });
});
