import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

/**
 * A daemon's Guard view as `machines.guard.get` returns it, for tests at the Machine RPC boundary:
 * defaults everywhere, nothing eligible, pressure reported, no ceiling (macOS). Overrides replace
 * whole top-level fields, as a later daemon answer would.
 */
export function createMachineGuardViewFixture(overrides: Partial<MachineGuardViewV1> = {}): MachineGuardViewV1 {
    return {
        policy: MachineGuardPolicyV1Schema.parse({}),
        policyRevision: 1,
        state: {
            v: 1,
            capabilities: {
                memoryPressure: { status: 'available' },
                ceiling: { status: 'unavailable', reason: 'not_linux' },
                keepAwake: { modes: ['off', 'on', 'on_power'] },
            },
            keepAwakeHolding: false,
        },
        ladder: {
            steps: [
                { rung: 'browsers', enabled: true, status: 'skip', freesAboutBytes: 0, candidates: [] },
                { rung: 'devServers', enabled: true, status: 'skip', freesAboutBytes: 0, candidates: [] },
                { rung: 'idleSessions', enabled: true, status: 'skip', freesAboutBytes: 0, candidates: [] },
            ],
            excluded: [],
            summary: { candidatesBytes: 0, inUseBytes: 0, workingBytes: 0, workingSessions: 0, notHappiersBytes: 0, leftAloneSessions: 0 },
        },
        othersWorkCount: 0,
        idle: [],
        leftBehind: { count: 0, footprintBytes: null },
        keepAwake: { holding: false, workingSessions: 0 },
        recentActivity: [],
        recentActivityOthers: 0,
        ...overrides,
    };
}
