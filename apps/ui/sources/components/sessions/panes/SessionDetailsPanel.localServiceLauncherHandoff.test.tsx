import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createSessionFixture, createMachineFixture, createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
// Cold Sync transformation belongs to collection, not the Account restore hook's deadline.
await loadSyncSingletonForTests();
const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
const { WorkspaceDetailsPanel } = await import('@/components/projects/panes/WorkspaceDetailsPanel');
const { resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } = await import('@/sync/domains/local/services/launch/sharedStore');
const serviceMethods: string[] = [];
let inventoryRead = createDeferred<void>();
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-a',
    features: () => createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, viewTargets: { enabled: true } } } }),
    request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a' })]);
        return createPlainMachineReadHttpResponseFixture(path, init, 'account-a');
    },
    rpc: async (method, _input, machineId) => {
    if (method.includes('localServices.')) serviceMethods.push(method);
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return new Promise(() => {});
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return {
        protocolVersion: 1, snapshot: { v: 1, machineId, sessionId: 'session-a', updatedAt: 3_000, targets: [] },
    };
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT
        || method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        await inventoryRead.promise;
        return {
        protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 3_000, refreshState: 'idle', entries: [], diagnostics: [] },
        };
    }
    throw new RpcError('Unsupported fixture RPC', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
} });
beforeEach(() => {
    serviceMethods.length = 0;
    inventoryRead = createDeferred<void>();
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
});

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
        try {
            await act(async () => runtime.pane.openDetailsTab({ key: 'file:a.txt', kind: 'file', title: 'a.txt',
                resource: { kind: 'file', path: 'a.txt' } }, { intent: 'pinned' }));
            await flushHookEffects({ cycles: 40 });
            expect(serviceMethods).toEqual([]);

            const browser = createBrowserLaunchpadDetailsTab();
            await act(async () => runtime.pane.openDetailsTab(browser, { intent: 'pinned' }));
            // Declaration hydration is independent of the inventory scan. A duplicate
            // Browser bootstrap would issue another launcher read before this reply.
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length).toBe(1);
            expect(serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH)).toEqual([]);
            inventoryRead.resolve();
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(1);
            // The first completed inventory scan reconciles that declaration exactly once.
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length).toBe(2);
            await act(async () => runtime.pane.setActiveDetailsTab('file:a.txt'));
            await flushHookEffects();
            const hiddenMethods = [...serviceMethods];
            await flushHookEffects();
            expect(serviceMethods).toEqual(hiddenMethods);
            await act(async () => runtime.pane.setActiveDetailsTab(browser.key));
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH).length).toBe(2);
            await expect.poll(() => serviceMethods.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT).length).toBe(3);
        } finally { inventoryRead.resolve(); await screen.unmount(); }
    });
    it.each([true, false])('honors supplied launcher state and explicit null without ambient reads (rows: %s)', async supplied => {
        const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a' })]);
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
                scopeId="session:session-a" nowMs={() => 4_000}
                localServiceLauncherState={supplied ? launcherState : null} localServicePreviewState={null} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' }));
        await flushHookEffects();
        if (supplied) expect(screen.getTextContent()).toContain('Session browser feed');
        else expect(screen.getTextContent()).not.toContain('Session browser feed');
        expect(serviceMethods).toEqual([]);
        await screen.unmount();
    });
});
