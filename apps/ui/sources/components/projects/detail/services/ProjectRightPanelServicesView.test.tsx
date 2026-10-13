import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import type { IModal } from '@/modal/types';
import { buildLocalServiceInventoryState } from '@/dev/testkit/fixtures/localServices';
import { pressTestInstanceAsync, renderScreen, flushHookEffects } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
    applyLocalServicePublicPreviewSnapshot,
    createLocalServicePublicPreviewState,
} from '@/sync/domains/local/services/publicPreview/store';

// Real Account lifetime beneath genuine network/device-credential boundaries;
// signed-out fixtures cannot dispatch through the mounted Services host.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { ProjectRightPanelServicesView } = await import('./ProjectRightPanelServicesView');
const { createFrontDoorRuntimeActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the daemon network is substituted; the mounted host and all Action dispatch run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        confirmResult: true,
        spies: { confirm: modalConfirmMock, show: modalShowMock },
    }).module;
});

async function publishFeatures(serverId: string, publicPreviewEnabled: boolean) {
    const features = createRootLayoutFeaturesResponse({ features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
            preview: { enabled: true }, publicPreview: { enabled: publicPreviewEnabled } },
        browser: { enabled: true, viewTargets: { enabled: true } },
    } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    // The real decision hook reads the Home's canonical published snapshot.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
}

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 3_000,
        targets: [{
            id: 'inventory:project-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'project-feed' },
            machineId: 'machine-a',
            title: 'Project feed service',
            subtitle: 'localhost:3000',
            confidence: 'medium',
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
            id: 'preview:project-feed',
            source: 'registered_preview',
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Project feed preview',
            subtitle: 'localhost:3000',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-project',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), {
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
    });
}

describe('ProjectRightPanelServicesView', () => {
    let serverId: string;
    beforeEach(async () => {
        await home.reset();
        serverId = await home.addHome({ name: 'Project Home', serverUrl: 'https://project.example.test', accountId: 'project-account', currentAccount: true });
        await publishFeatures(serverId, true);
        rpc.machine.mockReset();
        rpc.machine.mockImplementation(async () => { throw new Error('unexpected_machine_rpc'); });
        const scope = { serverId, accountId: 'project-account' };
        storage.setState({ profileScope: scope, settingsScope: scope });
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'], 'localServices.publicPreview.create': ['ui'] },
        } }), 1);
        modalConfirmMock.mockClear();
        modalShowMock.mockReset();
        modalShowMock.mockImplementation(() => 'modal-id');
    });
    afterEach(async () => { await home.reset(); });

    it('passes supplied local service launcher state into the Services pane', async () => {
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('mounts one body on the Services page and the rail: only the page leads with its purpose', async () => {
        const page = await renderScreen(
            <ProjectRightPanelServicesView
                presentation="page"
                testID="project-services-page"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(page.findByTestId('project-services-page-header')).toBeTruthy();
        expect(page.getTextContent()).toContain('Long-running services for this checkout');
        expect(page.findByTestId('project-services-page-row:inventory:project-feed')).toBeTruthy();
        await page.unmount();

        const rail = await renderScreen(
            <ProjectRightPanelServicesView
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
            />,
        );
        expect(rail.findAllByTestId('project-rightpanel-services-header')).toHaveLength(0);
        expect(rail.findByTestId('project-rightpanel-services-row:inventory:project-feed')).toBeTruthy();
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        await publishFeatures(serverId, false);
        const publicPreviewStatusClient = vi.fn(async () => ({
            ok: false as const,
            reason: 'unavailable' as const,
        }));

        await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                publicPreviewStatusClient={publicPreviewStatusClient}
            />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('builds a launcher start runtime action request without requiring session context', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServiceLauncherStartResponseV1Schema.parse({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'inventory:project-feed',
            status: 'succeeded',
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                updatedAt: 4_000,
                targets: [],
            },
        }));
        const runtimeActionExecute = vi.fn(createFrontDoorRuntimeActionExecutor());
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildLauncherState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        // Let the real asynchronous credential binding publish before user ingress.
        await flushHookEffects();
        await pressTestInstanceAsync(
            screen.findByTestId('project-rightpanel-services-row:inventory:project-feed-start'),
            'project-rightpanel-services-row:inventory:project-feed-start',
        );

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'inventory:project-feed',
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload: { machineId: 'machine-a', targetId: 'inventory:project-feed' },
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, machineId: 'machine-a', targetId: 'inventory:project-feed',
            status: 'succeeded', snapshot: { targets: [] },
        });
    });

    it('creates a public preview through the real Services Action host under the Account UI approval waiver', async () => {
        rpc.machine.mockResolvedValue(DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
            protocolVersion: 1,
            exposure: {
                exposureId: 'public-preview-1',
                previewId: 'preview-project',
                sessionId: 'session-a',
                machineId: 'machine-a',
                mode: 'secret_link',
                state: 'active',
                publicUrl: 'https://preview.example.test/public-preview-1',
                issuedAt: 4_000,
                expiresAt: 604_000,
                auditEventIds: ['audit-1'],
                rateLimitProfileId: 'default',
            },
            snapshot: {
                v: 1,
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-project',
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
            },
        }));
        const runtimeActionExecute = vi.fn(createFrontDoorRuntimeActionExecutor());
        const screen = await renderScreen(
            <ProjectRightPanelServicesView
                machineId="machine-a"
                serverId={serverId}
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={buildPublicPreviewLauncherState()}
                publicPreviewState={buildPublicPreviewState()}
                runtimeActionExecute={runtimeActionExecute}
            />,
        );

        await screen.pressByTestIdAsync('project-rightpanel-services-row:preview:project-feed-item');
        await flushHookEffects();
        await screen.pressByTestIdAsync('project-rightpanel-services-row:preview:project-feed-share');
        await flushHookEffects();

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine-a',
                sessionId: 'session-a',
                previewId: 'preview-project',
                mode: 'secret_link',
                ttlMs: 600_000,
                confirmation: { acknowledged: true },
            },
            context: {
                serverId,
                expectedAccountId: 'project-account',
                signal: expect.any(AbortSignal),
                surface: 'ui',
            },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, machineId: 'machine-a', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            payload: expect.objectContaining({ previewId: 'preview-project', sessionId: 'session-a',
                mode: 'secret_link', ttlMs: 600_000, confirmation: { acknowledged: true } }),
        }));
        await expect(runtimeActionExecute.mock.results[0]!.value).resolves.toMatchObject({
            protocolVersion: 1, exposure: { exposureId: 'public-preview-1', previewId: 'preview-project',
                publicUrl: 'https://preview.example.test/public-preview-1' },
        });
    });
});
