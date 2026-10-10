import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveMachineActionCandidates } from './resolveMachineActionCandidates';

const nowMs = 1_900_000_000_000;
const machine = (id: string, activeAt = nowMs) => createMachineFixture({ id, activeAt });

describe('resolveMachineActionCandidates', () => {
    it('preserves every distinct same-name Machine in a stable order as presence changes', () => {
        const first = machine('d4ac-machine');
        const second = machine('f874-machine', nowMs - 1);
        const options = { onlineOnly: false, nowMs };
        expect(resolveMachineActionCandidates([second, first], options).map(candidate => candidate.id))
            .toEqual([first.id, second.id]);
        expect(resolveMachineActionCandidates([
            { ...second, activeAt: nowMs + 1, updatedAt: nowMs + 1 },
            { ...first, active: false, activeAt: nowMs - 120_000 },
        ], options).map(candidate => candidate.id)).toEqual([first.id, second.id]);
    });

    it('collapses repeated snapshots only for the same Machine id, keeping the newer one', () => {
        const old = machine('same-id', nowMs - 1);
        const current = { ...machine('same-id'), metadata: { ...old.metadata!, host: 'renamed' } };
        expect(resolveMachineActionCandidates([old, current], { nowMs })).toEqual([current]);
    });

    it('filters offline Machines only when requested, including same-name Machines', () => {
        const online = machine('online');
        const offline = { ...machine('offline', nowMs - 120_000), active: false };
        expect(resolveMachineActionCandidates([offline, online], { nowMs })).toEqual([online]);
        expect(resolveMachineActionCandidates([offline, online], { onlineOnly: false, nowMs }))
            .toEqual([offline, online]);
    });

    it('keeps unnamed and locked Machine identities separate', () => {
        const unnamed = { ...machine('unnamed'), metadata: { ...machine('unnamed').metadata!, host: '' } };
        const locked = { ...machine('locked'), metadata: null };
        expect(resolveMachineActionCandidates([unnamed, locked], { nowMs }).map(candidate => candidate.id))
            .toEqual(['locked', 'unnamed']);
        expect(resolveMachineActionCandidates([], { nowMs })).toEqual([]);
    });
});
