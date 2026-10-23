import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { dispatchPluginResolvedSemanticCommand } from './dispatchPluginResolvedSemanticCommand';

const launch = vi.hoisted(() => vi.fn());

vi.mock('./launchPluginSurfaceAction', () => ({ launchPluginSurfaceAction: launch }));

const SCOPED = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
    interactionEnabled: true,
});

function projection(): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 4,
        actionsById: Object.freeze({
            'acme.demo/read': Object.freeze({
                id: 'read',
                pluginId: 'acme.demo',
                occurrenceId: 'demo-action-occurrence-a',
                title: 'Read',
                scopes: ['global' as const],
                surfaces: ['ui' as const],
                execution: { target: 'daemon' as const },
                dangerLevel: 'safe',
                available: true,
            }),
        }),
    });
}

function unionProjectionWithActionOrigin(): PluginUiProjectionModel {
    const baseProjection = projection();
    const action = baseProjection.actionsById['acme.demo/read'];
    if (!action) throw new Error('Expected fixture Action projection');
    return Object.freeze({
        ...baseProjection,
        generation: 999,
        actionsById: Object.freeze({
            'acme.demo/read': Object.freeze({
                ...action,
                hostOrigin: Object.freeze({
                    machineId: 'machine-action',
                    serverId: 'server-action',
                    interactionEnabled: true,
                    phase: 'current' as const,
                    executionOrigin: {
                        serverIdentityId: 'srv_test',
                        materializationRef: {
                            pluginId: 'acme.demo',
                            machineId: 'machine-action',
                            materializationId: 'machine-action:acme.demo',
                        },
                    },
                }),
            }),
        }),
    });
}

function unionProjectionWithOriginlessAction(): PluginUiProjectionModel {
    const projection = unionProjectionWithActionOrigin();
    const action = projection.actionsById['acme.demo/read'];
    if (!action) throw new Error('Expected fixture Action projection');
    return Object.freeze({
        ...projection,
        actionsById: Object.freeze({
            'acme.demo/read': Object.freeze({
                ...action,
                occurrenceId: 'demo-originless-action-occurrence-b',
                hostOrigin: Object.freeze({
                    machineId: 'machine-action',
                    serverId: 'server-action',
                    interactionEnabled: true,
                    phase: 'current' as const,
                    executionOrigin: null,
                }),
            }),
        }),
    });
}

beforeEach(() => {
    launch.mockReset();
    launch.mockResolvedValue({ kind: 'settled', outcome: { ok: true, result: null } });
});

describe('dispatchPluginResolvedSemanticCommand', () => {
    it('keeps an unchanged plugin Action usable when only a peer advances the aggregate projection', async () => {
        const aggregateAdvanced = Object.freeze({ ...projection(), generation: 5 });
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: aggregateAdvanced,
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: SCOPED,
        });

        expect(outcome).toEqual({ ok: true, result: null });
        expect(launch).toHaveBeenCalledOnce();
    });

    it('carries the caller AbortSignal into the canonical dispatcher', async () => {
        const controller = new AbortController();
        await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: SCOPED,
            signal: controller.signal,
        });
        expect(launch.mock.calls[0]![0].signal).toBe(controller.signal);
        // Structured identity, never the qualified string: a bare string would
        // be offered to the host ActionSpec branch first.
        expect(launch.mock.calls[0]![0].action).toEqual({ pluginId: 'acme.demo', localId: 'read' });
        expect(launch.mock.calls[0]![0].contributedAction).toMatchObject({
            machineId: 'machine-1',
        });
    });

    it('uses the resolved Action origin while retaining the exact Action occurrence', async () => {
        await dispatchPluginResolvedSemanticCommand({
            projection: unionProjectionWithActionOrigin(),
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: {
                serverId: null,
                machineId: null,
                interactionEnabled: true,
            },
        });

        expect(launch.mock.calls[0]![0].contributedAction).toMatchObject({
            machineId: 'machine-action',
            serverId: 'server-action',
        });
    });

    it('dispatches an originless Action through its selected machine and exact occurrence', async () => {
        const projection = unionProjectionWithOriginlessAction();
        await dispatchPluginResolvedSemanticCommand({
            projection,
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: {
                serverId: null,
                machineId: null,
                interactionEnabled: true,
            },
        });

        expect(launch).toHaveBeenCalledOnce();
        expect(launch.mock.calls[0]![0].contributedAction).toMatchObject({
            machineId: 'machine-action',
            serverId: 'server-action',
        });
        expect(launch.mock.calls[0]![0].resolveContributedAction({
            pluginId: 'acme.demo',
            localId: 'read',
        })?.occurrenceId).toBe('demo-originless-action-occurrence-b');
    });

    it('routes openSurface to the destination owner rather than the Action dispatcher', async () => {
        const openSurface = vi.fn().mockResolvedValue({ ok: true });
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: {
                kind: 'openSurface',
                destination: { pluginId: 'acme.demo', localId: 'page' },
                input: { v: 1 },
                subPath: '',
            },
            scopedLaunchFacts: SCOPED,
            openSurface,
        });
        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.demo', localId: 'page' },
            input: { v: 1 },
            subPath: '',
        });
        expect(launch).not.toHaveBeenCalled();
        expect(outcome).toEqual({ ok: true });
    });

    /**
     * The preflight runs BEFORE the outward navigation, exactly as the Action
     * branch runs it before dispatch. Opening a destination is an outward
     * effect on the reader's shell; a row whose admitting projection is already
     * retired must not perform it.
     */
    it('refuses an openSurface command once its registered scope retires', async () => {
        const openSurface = vi.fn().mockResolvedValue({ ok: true });
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: { kind: 'openSurface', destination: { pluginId: 'acme.demo', localId: 'page' } },
            scopedLaunchFacts: { ...SCOPED, interactionEnabled: false },
            openSurface,
        });
        expect(outcome).toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    it('refuses an openSurface command once the Account scope is no longer current', async () => {
        const openSurface = vi.fn().mockResolvedValue({ ok: true });
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: { kind: 'openSurface', destination: { pluginId: 'acme.demo', localId: 'page' } },
            scopedLaunchFacts: SCOPED,
            scopeIsCurrent: () => false,
            openSurface,
        });
        expect(outcome).toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    /**
     * The navigation itself commonly retires the source surface. The preflight
     * is therefore the only fence: a current open that unmounts its origin must
     * still settle as the success it was.
     */
    it('succeeds for a current open whose navigation retires the source surface', async () => {
        let current = true;
        const openSurface = vi.fn().mockImplementation(async () => {
            current = false;
            return { ok: true };
        });
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: { kind: 'openSurface', destination: { pluginId: 'acme.demo', localId: 'page' } },
            scopedLaunchFacts: SCOPED,
            scopeIsCurrent: () => current,
            openSurface,
        });
        expect(openSurface).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ ok: true });
    });

    it('refuses a daemon Action once its registered scope retires', async () => {
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: projection(),
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: { ...SCOPED, interactionEnabled: false },
        });
        expect(outcome).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });
        expect(launch).not.toHaveBeenCalled();
    });

    it('refuses an Action the current projection no longer publishes as available', async () => {
        const retired = Object.freeze({
            ...projection(),
            actionsById: Object.freeze({}),
        }) as PluginUiProjectionModel;
        const outcome = await dispatchPluginResolvedSemanticCommand({
            projection: retired,
            callerPluginId: 'acme.demo',
            command: { kind: 'executeAction', action: { pluginId: 'acme.demo', localId: 'read' } },
            scopedLaunchFacts: SCOPED,
        });
        expect(outcome).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });
        expect(launch).not.toHaveBeenCalled();
    });
});
