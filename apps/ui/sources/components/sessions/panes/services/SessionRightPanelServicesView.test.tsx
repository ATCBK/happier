import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCreateRequestV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import {
    createMachineFixture,
    createSessionFixture,
    buildLocalServiceInventoryRow,
    buildLocalServiceInventoryState,
    pressTestInstanceAsync,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch/store';
import type { LocalServiceLauncherSnapshot } from '@/sync/domains/local/services/launch/types';
import type { LocalServiceLauncherSnapshotClient } from '@/sync/domains/local/services/launch/useLocalServiceLauncherState';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

type MachineRpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')['machineRpcWithServerScope']>[0];
const daemonRpc = vi.hoisted(() => vi.fn<(request: MachineRpcRequest) => Promise<unknown>>());
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
/**
 * The public-link consequence sheet (`showLocalServiceExposureSheet`, F0 §3.D) is one `Modal.show`
 * card that returns the chosen link type and lifetime; answer it with the first of each.
 */
const modalShowMock = vi.hoisted(() => vi.fn((config: unknown) => {
    const props = (config as { props?: {
        modeChoices: readonly { mode: string }[];
        ttlChoices: readonly { ttlMs: number }[];
        onResolve: (decision: { mode: string; ttlMs: number } | null) => void;
    } }).props;
    const mode = props?.modeChoices[0];
    const ttl = props?.ttlChoices[0];
    props?.onResolve(mode && ttl ? { mode: mode.mode, ttlMs: ttl.ttlMs } : null);
    return 'modal-id';
}));

// The daemon network port is the only substituted Action dependency; admission,
// Account lifetime, request construction and response validation stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => (
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(daemonRpc)
));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: { confirm: modalConfirmMock, show: modalShowMock as never },
    }).module;
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SessionRightPanelServicesView } = await import('./SessionRightPanelServicesView');
const { storage } = await import('@/sync/domains/state/storage');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetLocalServiceLauncherStoreForTests } = await import('@/sync/domains/local/services/launch/sharedStore');
const { resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServicePublicPreviewStoreForTests } = await import('@/sync/domains/local/services/publicPreview/sharedStore');
let serverId: string;

async function publishFeatures(publicPreviewEnabled = true) {
    const features = createRootLayoutFeaturesResponse({ features: { localServices: {
        enabled: true, inventory: { enabled: true }, managed: { enabled: true }, launcher: { enabled: true },
        actions: { enabled: true, terminate: { enabled: true } }, preview: { enabled: true },
        publicPreview: { enabled: publicPreviewEnabled },
    } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    expect((await getServerFeaturesSnapshot({ serverId, force: true })).status).toBe('ready');
}

function daemonRequests(method: string) {
    return daemonRpc.mock.calls.map(([request]) => request).filter(request => request.method === method)
        .map(({ serverId, machineId, payload }) => ({ serverId, machineId, payload }));
}

async function defaultDaemonResponse(request: MachineRpcRequest) {
    if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        return { protocolVersion: 1, snapshot: { v: 1, machineId: request.machineId,
            generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] } };
    }
    if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
        return await new Promise(resolve => {
            const finish = () => resolve({ protocolVersion: 1, changed: false });
            if (request.signal?.aborted) finish();
            else request.signal?.addEventListener('abort', finish, { once: true });
        });
    }
    if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS) {
        return { protocolVersion: 1, snapshot: publicPreviewSnapshot() };
    }
    throw new Error(`Unexpected Services RPC method: ${request.method}`);
}

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'managed:session-feed',
            source: 'managed_service',
            sourceClass: {
                kind: 'managed_service',
                managedServiceId: 'session-feed',
            },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Session feed preview',
            subtitle: 'localhost:5173',
            kind: 'managed_service',
            confidence: 'high',
            state: 'available',
            actions: ['start'],
        }],
    });
}


function buildPublicPreviewLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'inventory:session-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'session-feed' },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Session feed preview',
            subtitle: 'localhost:5173',
            confidence: 'high',
            state: 'available',
            actions: ['open_preview'],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-session',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

const liveStartSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 3_000,
    targets: [{
        id: 'managed:session-feed',
        source: 'managed_service',
        sourceClass: {
            kind: 'managed_service',
            managedServiceId: 'session-feed',
        },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Session feed preview',
        subtitle: 'localhost:5173',
        kind: 'managed_service',
        confidence: 'high',
        state: 'available',
        actions: ['start'],
    }],
} satisfies LocalServiceLauncherSnapshot;

function publicPreviewSnapshot(): Parameters<typeof applyLocalServicePublicPreviewSnapshot>[1] {
    return {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 2,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: [],
        diagnostics: [],
    };
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), publicPreviewSnapshot());
}

describe('SessionRightPanelServicesView', () => {
    beforeEach(async () => {
        await homes.reset();
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
        resetLocalServicePublicPreviewStoreForTests();
        daemonRpc.mockReset();
        daemonRpc.mockImplementation(defaultDaemonResponse);
        serverId = await homes.addHome({ name: 'Session Services', serverUrl: 'https://session-services.test',
            accountId: 'account-services', currentAccount: true });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 0 } });
        await publishFeatures();
        modalConfirmMock.mockClear();
        modalShowMock.mockClear();
    });
    afterEach(async () => {
        await standardCleanup();
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
        resetLocalServicePublicPreviewStoreForTests();
        await homes.reset();
    });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        await publishFeatures(false);

        await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId={serverId}
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(daemonRequests(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS)).toEqual([]);
    });


    it('builds a terminate-detected runtime action request for eligible detected rows', async () => {
        daemonRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE) return defaultDaemonResponse(request);
            const input = LocalServiceActionRequestV1Schema.parse(request.payload);
            return { protocolVersion: 1, result: { v: 1, requestId: input.requestId,
                action: input.action, status: 'succeeded', auditEvents: [] } };
        });
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1,
            machineId: 'machine-a',
            sessionId: 'session-a',
            updatedAt: 3_000,
            targets: [{
                id: 'inventory:inventory-entry-1',
                source: 'inventory_entry',
                sourceClass: {
                    kind: 'inventory_entry',
                    inventoryEntryId: 'inventory-entry-1',
                },
                machineId: 'machine-a',
                sessionId: 'session-a',
                title: 'Detected app',
                subtitle: 'localhost:5173',
                confidence: 'high',
                state: 'available',
                actions: ['open', 'terminate_detected'],
                browserTarget: {
                    kind: 'externalUrl',
                    targetId: 'inventory-loopback:inventory-entry-1',
                    url: 'http://127.0.0.1:5173/',
                    display: { title: 'Detected app', addressLabel: 'localhost:5173' },
                },
            }],
        });
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId={serverId}
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({
                    rows: [buildLocalServiceInventoryRow({ id: 'inventory-entry-1', state: 'listening' })],
                })}
                launcherState={launcherState}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:inventory:inventory-entry-1-item'),
            'session-rightpanel-services-row:inventory:inventory-entry-1-item',
        );
        // Terminate lives in the expanded row's overflow (U-11): drive the action model the canonical
        // `ItemRowActions` menu was given rather than its portalled popover.
        const terminate = screen.findAll((node) => Array.isArray(node.props?.actions)
            && node.props?.overflowTriggerTestID === 'session-rightpanel-services-row:inventory:inventory-entry-1-overflow')
            .flatMap((node) => node.props.actions as Array<{ id: string; onPress: () => void }>)
            .find((action) => action.id === 'terminate');
        expect(terminate).toBeTruthy();
        await act(async () => {
            terminate?.onPress();
            for (let i = 0; i < 8; i += 1) await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(daemonRequests(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE)).toEqual([{
            serverId,
            machineId: 'machine-a',
            payload: {
                requestId: expect.any(String),
                target: {
                    kind: 'inventory_entry',
                    inventoryEntryId: 'inventory-entry-1',
                    machineId: 'machine-a',
                    sessionId: 'session-a',
                },
                action: 'terminate_detected',
                force: false,
                confirmationNonce: expect.any(String),
            },
        }]));
        expect(modalConfirmMock).toHaveBeenCalledOnce();
    });


    it('builds a launcher start runtime action request for daemon-advertised Start targets', async () => {
        daemonRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return defaultDaemonResponse(request);
            const input = DaemonLocalServiceLauncherStartRequestV1Schema.parse(request.payload);
            return { protocolVersion: 1, machineId: input.machineId, targetId: input.targetId,
                status: 'succeeded', snapshot: { v: 1, machineId: input.machineId,
                    sessionId: input.sessionId, updatedAt: 4_000, targets: [] } };
        });
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId={serverId}
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start'),
            'session-rightpanel-services-row:managed:session-feed-start',
        );

        await waitForHomeGovernance(() => expect(daemonRequests(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)).toEqual([{
            serverId,
            machineId: 'machine-a',
            payload: {
                machineId: 'machine-a',
                targetId: 'managed:session-feed',
                sessionId: 'session-a',
            },
        }]));
    });

    it('replaces live launcher state from successful Start response snapshots', async () => {
        const startedSnapshot = {
            ...liveStartSnapshot,
            updatedAt: 4_000,
            targets: [{
                ...liveStartSnapshot.targets[0],
                state: 'starting',
                actions: [],
            }],
        } satisfies LocalServiceLauncherSnapshot;
        const launcherSnapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: liveStartSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        daemonRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) return defaultDaemonResponse(request);
            const input = DaemonLocalServiceLauncherStartRequestV1Schema.parse(request.payload);
            return { protocolVersion: 1, machineId: input.machineId, targetId: input.targetId,
                status: 'succeeded', snapshot: startedSnapshot };
        });
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId={serverId}
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherSnapshotClient={launcherSnapshotClient}
            />,
        );

        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start')).toBeTruthy();
        });

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:managed:session-feed-start'),
            'session-rightpanel-services-row:managed:session-feed-start',
        );

        await waitForHomeGovernance(() => {
            expect(screen.findAllByTestId('session-rightpanel-services-row:managed:session-feed-start')).toHaveLength(0);
            expect(screen.findByTestId('session-rightpanel-services-row:managed:session-feed-status-starting')).toBeTruthy();
        });
    });

    it('reads launcher state from the explicit Home when the active Home contains the same Session id', async () => {
        const before = storage.getState();
        const ownMachine = createMachineFixture({ id: 'machine-a', active: true });
        const otherMachine = createMachineFixture({ id: 'machine-other', active: true });
        const ownSession = createSessionFixture({ id: 'session-a', serverId, active: true, metadata: { machineId: 'machine-a', path: '/a', host: 'host-a' } });
        const otherSession = createSessionFixture({ id: 'session-a', serverId: 'server-other', active: true, metadata: { machineId: 'machine-other', path: '/other', host: 'host-other' } });
        storage.setState({
            sessions: { 'session-a': otherSession },
            machines: { 'machine-a': ownMachine, 'machine-other': otherMachine },
            machineListByServerId: { [serverId]: [ownMachine], 'server-other': [otherMachine] },
            sessionListRowsByServerId: { [serverId]: { 'session-a': buildSessionListRenderableFromSession(ownSession) } },
        });
        const launcherSnapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: liveStartSnapshot })) satisfies LocalServiceLauncherSnapshotClient;
        try {
            const screen = await renderScreen(<SessionRightPanelServicesView
                sessionId="session-a" serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                publicPreviewState={buildPublicPreviewState()}
                launcherSnapshotClient={launcherSnapshotClient}
            />);
            expect(launcherSnapshotClient).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-a', serverId, sessionId: 'session-a',
            }));
            await screen.unmount();
        } finally {
            storage.setState(before);
        }
    });

    it('creates public preview links through the session Services runtime action host', async () => {
        daemonRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE) return defaultDaemonResponse(request);
            const input = DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(request.payload);
            return {
                protocolVersion: 1,
                previewId: input.previewId,
                exposureId: 'public-preview-1',
                status: 'created',
                exposure: {
                    exposureId: 'public-preview-1',
                    previewId: input.previewId,
                    sessionId: input.sessionId,
                    machineId: input.machineId,
                    mode: input.mode,
                    state: 'active',
                    publicUrl: 'https://preview.example.test/public-preview-1',
                    issuedAt: 4_000,
                    expiresAt: 604_000,
                    auditEventIds: ['audit-1'],
                    rateLimitProfileId: 'default',
                },
                snapshot: publicPreviewSnapshot(),
            };
        });
        const screen = await renderScreen(
            <SessionRightPanelServicesView
                sessionId="session-a"
                serverId={serverId}
                machineId="machine-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:inventory:session-feed-item'),
            'session-rightpanel-services-row:inventory:session-feed-item',
        );
        await pressTestInstanceAsync(
            screen.findByTestId('session-rightpanel-services-row:inventory:session-feed-share'),
            'session-rightpanel-services-row:inventory:session-feed-share',
        );
        await waitForHomeGovernance(() => expect(daemonRequests(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)).toEqual([{
            serverId,
            machineId: 'machine-a',
            payload: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-session',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
        }]));
        expect(modalShowMock).toHaveBeenCalledOnce();
    });
});
