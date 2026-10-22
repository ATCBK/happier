import { expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { resolveMachineSessionListIndexImpact } from './machineSessionListIndexImpact';

it('does not inspect sessions when machine updates cannot change project grouping', () => {
    const session = {
        id: 's1',
        get metadata(): never {
            throw new Error('activity-only machine updates must not scan session metadata');
        },
    } as any;
    const previousMachine = {
        id: 'm1',
        updatedAt: 1,
        active: true,
        activeAt: 1,
        revokedAt: null,
        metadataVersion: 1,
        metadata: { displayName: 'Mac', host: 'host-1', homeDir: '/home/u' },
    };

    expect(resolveMachineSessionListIndexImpact({
        usesProjectGrouping: true,
        sessions: [session],
        previousMachineDisplays: { m1: previousMachine },
        nextMachineDisplays: {
            m1: {
                ...previousMachine,
                updatedAt: 2,
                activeAt: 2,
            },
        },
    })).toEqual({
        needsSessionListIndexRebuild: false,
        needsProjectManagerUpdate: false,
    });
});

it('keeps project placement idle when only the machine metadata revision advances', () => {
    const machine = {
        id: 'm1', updatedAt: 1, active: true, activeAt: 1, metadataVersion: 1,
        metadata: { displayName: 'Reading desk', host: 'host-1', homeDir: '/home/u' },
    };
    let sessionReads = 0;
    const session = {
        ...createSessionListRenderableSessionFixture({ id: 's1' }),
        get metadata() {
            sessionReads += 1;
            return { machineId: 'm1', path: '/home/u/repo' };
        },
    };
    const impact = resolveMachineSessionListIndexImpact({
        usesProjectGrouping: true,
        sessions: [session],
        previousMachineDisplays: { m1: machine },
        nextMachineDisplays: { m1: { ...machine, metadataVersion: 2 } },
    });
    expect(impact).toEqual({ needsSessionListIndexRebuild: false, needsProjectManagerUpdate: false });
    expect(sessionReads).toBe(0);
});
