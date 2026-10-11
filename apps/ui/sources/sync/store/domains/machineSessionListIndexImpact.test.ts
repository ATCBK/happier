import { expect, it } from 'vitest';

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
