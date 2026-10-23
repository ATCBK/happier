import type {
    BrowserViewTargetV1,
    LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Vite app',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
    },
} satisfies BrowserViewTargetV1;

const pluginTarget = {
    kind: 'externalUrl',
    targetId: 'browserTarget:acme.preview:previewPane',
    url: 'https://preview.happier.test/plugin/acme/',
} satisfies BrowserViewTargetV1;

const launcherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        kind: 'vite',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: localPreviewTarget,
    }, {
        id: 'launcher_stale',
        source: 'inventory_entry',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Old service',
        subtitle: 'localhost:4000',
        confidence: 'medium',
        state: 'stale',
        unavailableReason: 'stale_service',
        actions: ['open_preview'],
        browserTarget: {
            ...localPreviewTarget,
            targetId: 'preview_stale',
            display: {
                title: 'Old service',
                addressLabel: 'localhost:4000',
            },
        },
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const pluginProjection = {
    generation: 2,
    targetsById: {
        'browserTarget:acme.preview:previewPane': {
            id: 'browserTarget:acme.preview:previewPane',
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            contributionId: 'previewPane',
            target: pluginTarget,
            display: {
                title: 'Plugin Preview',
                addressLabel: 'https://preview.happier.test/plugin/acme/',
            },
            currentUrl: 'https://preview.happier.test/plugin/acme/',
            launchMode: 'currentView',
            profileMode: 'session',
        },
    },
    actionsById: {},
    unknownEntriesById: {},
} satisfies PluginBrowserProjectionModel;

describe('browser launchpad suggestions', () => {
    it('builds ranked launchpad rows from LSV launcher snapshots, plugin browser targets, and recents', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');

        const rows = buildBrowserLaunchpadRows({
            launcherSnapshot,
            pluginBrowserProjection: pluginProjection,
            recents: [{
                target: {
                    ...localPreviewTarget,
                    targetId: 'preview_recent',
                    display: {
                        title: 'Recent app',
                        addressLabel: 'localhost:3000',
                    },
                },
                openedAt: 2_000,
            }],
            nowMs: 3_000,
        });

        // Running services are the Local services rows (carried as `serviceRow`); a stale one is not
        // listed as a dead launchpad row (it stays in Local services with its own state).
        expect(rows.map((row) => row.id)).toEqual([
            'service:launcher_preview',
            'pluginExternalUrl:browserTarget:acme.preview:previewPane',
            'recent:preview_recent',
        ]);
        expect(rows[0]).toMatchObject({
            section: 'running',
            title: 'Vite app',
            disabledReason: null,
            target: localPreviewTarget,
        });
        expect(rows[0]?.serviceRow).toMatchObject({ id: 'launcher_preview', status: 'running' });
        expect(rows[1]).toMatchObject({
            section: 'plugin',
            title: 'Plugin Preview',
            target: pluginTarget,
            currentUrl: 'https://preview.happier.test/plugin/acme/',
            sourceKind: 'pluginExternalUrl',
            launchMode: 'currentView',
            profileMode: 'session',
        });
        expect(rows[2]).toMatchObject({
            section: 'recent',
            title: 'Recent app',
        });
    });

    it('evaluates plugin target availability with the host policy context and fails closed without it', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const projection = {
            ...pluginProjection,
            targetsById: {
                'browserTarget:acme.preview:previewPane': {
                    ...pluginProjection.targetsById['browserTarget:acme.preview:previewPane'],
                    availability: {
                        when: { fact: 'host.platform', operator: 'equals', value: 'desktop' },
                    },
                },
            },
        } satisfies PluginBrowserProjectionModel;

        expect(buildBrowserLaunchpadRows({ pluginBrowserProjection: projection })).toEqual([]);
        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'desktop' },
        })).toHaveLength(1);
        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'ios' },
        })).toEqual([]);
    });

    it('keeps a policy-disabled plugin target visible with its exact authored unavailable reason', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');
        const projection = {
            ...pluginProjection,
            targetsById: {
                [pluginTarget.targetId]: {
                    ...pluginProjection.targetsById['browserTarget:acme.preview:previewPane'],
                    availability: {
                        disabledWhen: {
                            fact: 'host.platform',
                            operator: 'equals',
                            value: 'desktop',
                        },
                        disabledReason: 'Open this target on a mobile device.',
                    },
                },
            },
        } satisfies PluginBrowserProjectionModel;

        expect(buildBrowserLaunchpadRows({
            pluginBrowserProjection: projection,
            pluginBrowserPolicyContext: { platform: 'desktop' },
        })).toEqual([
            expect.objectContaining({
                id: `pluginExternalUrl:${pluginTarget.targetId}`,
                section: 'unavailable',
                disabledReason: 'Open this target on a mobile device.',
            }),
        ]);
    });

    it('B-RC6: plugin row identity and lastSeenAt are stable across polls (nowMs does not churn identity)', async () => {
        const { buildBrowserLaunchpadRows } = await import('./suggestions');

        const buildAt = (nowMs: number) => buildBrowserLaunchpadRows({
            pluginBrowserProjection: pluginProjection,
            nowMs,
        });

        const first = buildAt(1_000);
        const second = buildAt(9_999);

        const firstPlugin = first.find((row) => row.section === 'plugin');
        const secondPlugin = second.find((row) => row.section === 'plugin');
        expect(firstPlugin).toBeDefined();
        expect(secondPlugin).toBeDefined();
        // Same structural input + different nowMs → identical id AND identical lastSeenAt (no flicker).
        expect(secondPlugin?.id).toBe(firstPlugin?.id);
        expect(secondPlugin?.lastSeenAt).toBe(firstPlugin?.lastSeenAt);
    });


    describe('the running Service an ended preview can open again', () => {
        const declaration = { workspaceRefId: 'ws_1', selection: { kind: 'manifest', name: 'web' } } as const;
        const endedDeclared = {
            kind: 'localServicePreview',
            targetId: 'preview_old',
            machineId: 'machine_1',
            display: { title: 'Web', addressLabel: 'localhost:42512' },
            serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old', machineId: 'machine_1', cwd: '/repo', declaration },
        } satisfies BrowserViewTargetV1;
        const endedScanned = {
            kind: 'localServicePreview',
            targetId: 'preview_scanned_old',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Lumen', addressLabel: '127.0.0.1:42511' },
        } satisfies BrowserViewTargetV1;
        const snapshot = (targets: LocalServiceLauncherSnapshotV1['targets']) => ({
            v: 1, machineId: 'machine_1', sessionId: 'session_1', updatedAt: 1_000, targets,
        }) satisfies LocalServiceLauncherSnapshotV1;
        const declaredRunning: LocalServiceLauncherSnapshotV1['targets'][number] = {
            id: 'managed:instance_new', source: 'managed_service', machineId: 'machine_1', title: 'web', subtitle: 'localhost:42512',
            sourceClass: { kind: 'managed_service', managedServiceId: 'instance_new' }, cwd: '/repo', declaration,
            serviceState: 'running', endpointUrl: 'http://127.0.0.1:42512/', confidence: 'high', state: 'available', actions: ['register_preview'],
        };
        const scannedRunning: LocalServiceLauncherSnapshotV1['targets'][number] = {
            id: 'inventory:entry_new', source: 'inventory_entry', machineId: 'machine_1', sessionId: 'session_1', title: 'node', subtitle: '127.0.0.1:42511',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry_new' }, endpointUrl: 'http://127.0.0.1:42511/',
            confidence: 'high', state: 'available', actions: ['register_preview'],
        };

        it('finds the current occurrence of the same declared Service, not another Service on the machine', async () => {
            const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
            const rows = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([
                { ...scannedRunning },
                { ...declaredRunning },
            ]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(rows, endedDeclared)?.id).toBe('managed:instance_new');
            const otherDeclaration = { ...declaredRunning, declaration: { ...declaration, selection: { kind: 'manifest', name: 'api' } } } satisfies LocalServiceLauncherSnapshotV1['targets'][number];
            const without = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([otherDeclaration]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(without, endedDeclared)).toBeNull();
        });

        it('finds a scanned listener on the same machine and port, and nothing once it stopped', async () => {
            const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('./suggestions');
            const running = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([{ ...scannedRunning }]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(running, endedScanned)?.id).toBe('inventory:entry_new');
            expect(selectRunningServiceForEndedPreview(running, { ...endedScanned, machineId: 'machine_2' })).toBeNull();
            expect(selectRunningServiceForEndedPreview(running, { ...endedScanned, display: { title: 'Lumen', addressLabel: '127.0.0.1:42599' } })).toBeNull();
            const stopped = buildBrowserLaunchpadRows({ launcherSnapshot: snapshot([{ ...scannedRunning, state: 'stale' }]), nowMs: 2_000 });
            expect(selectRunningServiceForEndedPreview(stopped, endedScanned)).toBeNull();
        });
    });
});
