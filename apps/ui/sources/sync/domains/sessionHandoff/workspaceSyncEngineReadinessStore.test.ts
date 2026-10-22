import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyWorkspaceSyncEngineReadinessEvent,
    getWorkspaceSyncEngineReadinessSnapshot,
    resetWorkspaceSyncEngineReadinessStoreForTests,
    subscribeWorkspaceSyncEngineReadiness,
} from './workspaceSyncEngineReadinessStore';

describe('workspaceSyncEngineReadinessStore', () => {
    beforeEach(() => {
        resetWorkspaceSyncEngineReadinessStoreForTests();
    });

    it('projects the owning daemon engine and carrier readiness without probing status RPCs', () => {
        const scope = { serverId: 'server-1', machineId: 'machine-1' } as const;

        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'ready' },
            carrier: { state: 'ready' },
        });

        expect(getWorkspaceSyncEngineReadinessSnapshot(scope)).toEqual({
            phase: 'ready', errorCode: null, carrierPhase: 'ready', carrierErrorCode: null,
        });
    });

    it('keeps the exact daemon engine failure code', () => {
        const scope = { machineId: 'machine-1' } as const;

        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
            carrier: { state: 'ready' },
        });

        expect(getWorkspaceSyncEngineReadinessSnapshot(scope)).toEqual({
            phase: 'unavailable',
            errorCode: 'engine_unavailable',
            carrierPhase: 'ready',
            carrierErrorCode: null,
        });
    });

    it('retains equal readiness snapshots and publishes engine, carrier, and recovery changes', () => {
        const scope = { serverId: 'server-1', machineId: 'machine-1' } as const;
        const listener = vi.fn();
        subscribeWorkspaceSyncEngineReadiness(scope, listener);
        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
            carrier: { state: 'unavailable', errorCode: 'carrier_unavailable' },
        });
        const unavailable = getWorkspaceSyncEngineReadinessSnapshot(scope);
        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
            carrier: { state: 'unavailable', errorCode: 'carrier_unavailable' },
        });
        expect(getWorkspaceSyncEngineReadinessSnapshot(scope)).toBe(unavailable);
        expect(listener).toHaveBeenCalledOnce();

        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'unavailable', errorCode: 'engine_not_installed' },
            carrier: { state: 'unavailable', errorCode: 'carrier_unavailable' },
        });
        expect(getWorkspaceSyncEngineReadinessSnapshot(scope).errorCode).toBe('engine_not_installed');
        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'unavailable', errorCode: 'engine_not_installed' },
            carrier: { state: 'ready' },
        });
        expect(getWorkspaceSyncEngineReadinessSnapshot(scope).carrierErrorCode).toBeNull();
        applyWorkspaceSyncEngineReadinessEvent(scope, { engine: { state: 'ready' }, carrier: { state: 'ready' } });
        expect(getWorkspaceSyncEngineReadinessSnapshot(scope).phase).toBe('ready');
        expect(listener).toHaveBeenCalledTimes(4);
    });

    it('keeps the exact carrier failure when the engine is ready', () => {
        const scope = { machineId: 'machine-1' } as const;

        applyWorkspaceSyncEngineReadinessEvent(scope, {
            engine: { state: 'ready' },
            carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
        });

        expect(getWorkspaceSyncEngineReadinessSnapshot(scope)).toEqual({
            phase: 'ready',
            errorCode: null,
            carrierPhase: 'unavailable',
            carrierErrorCode: 'machine_carrier_unavailable',
        });
    });

    it('scopes readiness per machine and notifies only that machine subscribers', () => {
        const first = { serverId: 'server-1', machineId: 'machine-1' } as const;
        const second = { serverId: 'server-1', machineId: 'machine-2' } as const;
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        const unsubscribeFirst = subscribeWorkspaceSyncEngineReadiness(first, firstListener);
        const unsubscribeSecond = subscribeWorkspaceSyncEngineReadiness(second, secondListener);

        applyWorkspaceSyncEngineReadinessEvent(second, {
            engine: { state: 'starting' },
            carrier: { state: 'ready' },
        });

        expect(firstListener).not.toHaveBeenCalled();
        expect(secondListener).toHaveBeenCalled();
        expect(getWorkspaceSyncEngineReadinessSnapshot(second)).toEqual({
            phase: 'probing', errorCode: null, carrierPhase: 'ready', carrierErrorCode: null,
        });
        expect(getWorkspaceSyncEngineReadinessSnapshot(first)).toEqual({
            phase: 'idle', errorCode: null, carrierPhase: 'unknown', carrierErrorCode: null,
        });
        unsubscribeFirst();
        unsubscribeSecond();
    });
});
