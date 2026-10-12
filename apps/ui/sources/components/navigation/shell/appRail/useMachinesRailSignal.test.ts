import { describe, expect, it } from 'vitest';

import { buildMachinesRailSeen, resolveMachinesRailSignal } from './useMachinesRailSignal';

const calm = { needsYou: [], look: [], lastAutomaticActionAt: null, headline: null } as const;
const NO_SEEN = { look: {}, guardSeenAt: 0 };

describe('the Machines rail badge (R4)', () => {
    it('counts the machines that need you, whatever this device has seen', () => {
        const fleet = { ...calm, needsYou: [{ serverId: 'a', machineId: 'm1' }, { serverId: 'a', machineId: 'm2' }],
            look: [{ machineKey: '["a","m3"]', reasonKey: 'disk:/data' }] };
        expect(resolveMachinesRailSignal({ fleet, seen: buildMachinesRailSeen(fleet, 10) }))
            .toEqual({ level: 'needs_you', signal: { kind: 'count', value: 2, tone: 'attention' } });
    });

    it('dots a reason worth a look until the popover opens, and again only for a new reason', () => {
        const fleet = { ...calm, look: [{ machineKey: '["a","m3"]', reasonKey: 'disk:/data' }] };
        expect(resolveMachinesRailSignal({ fleet, seen: NO_SEEN }).signal).toEqual({ kind: 'dot', tone: 'attention' });
        const seen = buildMachinesRailSeen(fleet, 10);
        expect(resolveMachinesRailSignal({ fleet, seen }).signal).toBeNull();
        const worse = { ...calm, look: [...fleet.look, { machineKey: '["a","m3"]', reasonKey: 'memory:elevated' }] };
        expect(resolveMachinesRailSignal({ fleet: worse, seen }).signal).toEqual({ kind: 'dot', tone: 'attention' });
    });

    it('forgets a reason that recovered, so a recurrence badges again', () => {
        const before = { ...calm, look: [{ machineKey: '["a","m3"]', reasonKey: 'disk:/data' }] };
        const afterRecovery = buildMachinesRailSeen(calm, 20);
        expect(afterRecovery.look).toEqual({});
        expect(resolveMachinesRailSignal({ fleet: before, seen: afterRecovery }).signal).toEqual({ kind: 'dot', tone: 'attention' });
    });

    it('shows a muted dot when the guard acted since the popover was last opened, and nothing when calm', () => {
        const acted = { ...calm, lastAutomaticActionAt: 50 };
        expect(resolveMachinesRailSignal({ fleet: acted, seen: { look: {}, guardSeenAt: 40 } }).signal).toEqual({ kind: 'dot', tone: 'neutral' });
        expect(resolveMachinesRailSignal({ fleet: acted, seen: { look: {}, guardSeenAt: 60 } }).signal).toBeNull();
        expect(resolveMachinesRailSignal({ fleet: calm, seen: NO_SEEN }).signal).toBeNull();
    });
});
