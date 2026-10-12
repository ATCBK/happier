import { beforeEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveMachineActionCandidates } from './resolveMachineActionCandidates';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const nowMs = 1_900_000_000_000;
const machine = (id: string, activeAt = nowMs) => createMachineFixture({ id, activeAt });

describe('resolveMachineActionCandidates', () => {
    beforeEach(() => clearMachineRequestReachabilityForTest());
    it('lists the Machines that can work first, each presence group in a stable name order', () => {
        // Same contract as the Machines collection: a picker over a mostly sleeping fleet opens on the online ones.
        const first = machine('d4ac-machine');
        const second = machine('f874-machine', nowMs - 1);
        const options = { onlineOnly: false, nowMs };
        expect(resolveMachineActionCandidates(scope, [second, first], options).map(candidate => candidate.id))
            .toEqual([first.id, second.id]);
        // A newer heartbeat never reorders inside a group; going offline moves a Machine behind the online ones.
        expect(resolveMachineActionCandidates(scope, [
            { ...second, activeAt: nowMs + 1, updatedAt: nowMs + 1 },
            { ...first, active: false, activeAt: nowMs - 120_000 },
        ], options).map(candidate => candidate.id)).toEqual([second.id, first.id]);
        const asleep = (id: string) => ({ ...machine(id, nowMs - 120_000), active: false });
        expect(resolveMachineActionCandidates(scope, [asleep('b-asleep'), first, asleep('a-asleep'), second], options)
            .map(candidate => candidate.id)).toEqual([first.id, second.id, 'a-asleep', 'b-asleep']);
    });

    it('collapses repeated snapshots only for the same Machine id, keeping the newer one', () => {
        const old = machine('same-id', nowMs - 1);
        const current = { ...machine('same-id'), metadata: { ...old.metadata!, host: 'renamed' } };
        expect(resolveMachineActionCandidates(scope, [old, current], { nowMs })).toEqual([current]);
    });

    it('filters offline Machines only when requested, including same-name Machines', () => {
        const online = machine('online');
        const offline = { ...machine('offline', nowMs - 120_000), active: false };
        expect(resolveMachineActionCandidates(scope, [offline, online], { nowMs })).toEqual([online]);
        expect(resolveMachineActionCandidates(scope, [offline, online], { onlineOnly: false, nowMs }))
            .toEqual([online, offline]);
    });

    it('keeps unnamed and locked Machine identities separate', () => {
        const unnamed = { ...machine('unnamed'), metadata: { ...machine('unnamed').metadata!, host: '' } };
        const locked = { ...machine('locked'), metadata: null, availability: { kind: 'locked', reason: 'decryption_failed' } as const };
        expect(resolveMachineActionCandidates(scope, [unnamed, locked], { nowMs }).map(candidate => candidate.id))
            .toEqual(['unnamed']);
        expect(resolveMachineActionCandidates(scope, [unnamed, locked], { onlineOnly: false, nowMs }).map(candidate => candidate.id))
            .toEqual(['unnamed', 'locked']);
        expect(resolveMachineActionCandidates(scope, [], { nowMs })).toEqual([]);
    });

    it('excludes request-unreachable and replaced supply without applying another Home\'s observations', () => {
        const failed = machine('failed');
        const replaced = { ...machine('replaced'), replacedByMachineId: 'replacement' };
        const available = machine('available');
        recordMachineRequestFailed({ ...scope, machineId: failed.id, observedAtMs: nowMs });
        expect(resolveMachineActionCandidates(scope, [failed, replaced, available], { nowMs })).toEqual([available]);
        expect(resolveMachineActionCandidates({ ...scope, serverId: 'home-b' }, [failed, replaced, available], { nowMs })).toEqual([available, failed]);
        expect(resolveMachineActionCandidates({ ...scope, accountId: 'account-b' }, [failed, replaced, available], { nowMs })).toEqual([available, failed]);
        expect(resolveMachineActionCandidates(scope, [failed, replaced, available], { onlineOnly: false, nowMs }))
            .toEqual([available, failed, replaced]);
    });
});
