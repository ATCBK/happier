import { describe, expect, it } from 'vitest';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';

import {
    isSessionListRuntimePriorityRow,
    resolveSessionListRuntimePriorityRowNextFreshnessAtMs,
} from './sessionListRuntimePriorityRows';

describe('isSessionListRuntimePriorityRow', () => {
    it('reuses immutable priority inputs until their freshness deadline and rechecks after a clock rewind', () => {
        let runtimeReads = 0;
        const row = {
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 990_000,
            get latestTurnStatus() {
                runtimeReads += 1;
                return null;
            },
        };
        const nowMs = 1_000_000;
        expect(isSessionListRuntimePriorityRow(row, nowMs)).toBe(true);
        const deadline = resolveSessionListRuntimePriorityRowNextFreshnessAtMs(row, nowMs);
        expect(deadline).not.toBeNull();
        const initialReads = runtimeReads;
        expect(initialReads).toBeGreaterThan(0);

        expect(isSessionListRuntimePriorityRow(row, nowMs + 1)).toBe(true);
        expect(resolveSessionListRuntimePriorityRowNextFreshnessAtMs(row, nowMs + 1)).toBe(deadline);
        expect(runtimeReads).toBe(initialReads);

        expect(isSessionListRuntimePriorityRow(row, deadline!)).toBe(true);
        expect(runtimeReads).toBeGreaterThan(initialReads);
        expect(isSessionListRuntimePriorityRow(row, deadline! + 1)).toBe(true);
        expect(resolveSessionListRuntimePriorityRowNextFreshnessAtMs(row, deadline! + 1)).toBeNull();
        expect(runtimeReads).toBeGreaterThan(initialReads);
        expect(isSessionListRuntimePriorityRow(row, nowMs)).toBe(true);
        expect(resolveSessionListRuntimePriorityRowNextFreshnessAtMs(row, nowMs)).toBe(deadline);
        expect(isSessionListRuntimePriorityRow({ ...row, active: false, thinking: false }, nowMs)).toBe(false);
    });

    it('prioritizes canonical background activity without sourceClass or timestamp freshness inference', () => {
        const nowMs = 1_000_000;
        const row = {
            id: 'stale-runtime',
            active: false,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: nowMs - 10_000,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 300_000,
            runtimeActivityRevision: nowMs - 1,
        };

        expect(isSessionListRuntimePriorityRow(row, nowMs)).toBe(true);
    });

    it.each([
        ['offline', { presence: 123_456 }],
        ['archived', { archivedAt: 123_456 }],
    ])('does not prioritize %s background activity', (_label, overrides) => {
        const row = {
            active: false,
            presence: 'online',
            thinking: false,
            latestTurnStatus: 'completed' as const,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
            runtimeActivityRevision: 1,
            ...overrides,
        };

        expect(isSessionListRuntimePriorityRow(row, 1_000_000)).toBe(false);
    });

    it('schedules loss of runtime observation without fabricating online thinking presence', () => {
        const nowMs = 1_000_000;
        const activeAt = nowMs - 10_000;
        expect(resolveSessionListRuntimePriorityRowNextFreshnessAtMs({
            active: true,
            activeAt,
            thinking: true,
            thinkingAt: nowMs,
        }, nowMs)).toBe(activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    });
});
