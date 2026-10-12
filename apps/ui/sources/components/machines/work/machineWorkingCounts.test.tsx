import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    MachineWorkingCountsScope,
    machineWorkingKey,
    useMachineWorkingCount,
    useMachineWorkingTotal,
    type MachineWorkingCounts,
} from './machineWorkingCounts';

function counts(entries: Readonly<Record<string, number>>): MachineWorkingCounts {
    const byMachine = new Map(Object.entries(entries).map(([machineId, count]) => [machineWorkingKey({ serverId: 'home', machineId }), count]));
    return { byMachine, total: [...byMachine.values()].reduce((sum, value) => sum + value, 0) };
}

const renders: Record<string, number> = {};

const Row = React.memo(function Row(props: Readonly<{ machineId: string }>) {
    renders[props.machineId] = (renders[props.machineId] ?? 0) + 1;
    const working = useMachineWorkingCount({ serverId: 'home', machineId: props.machineId });
    return React.createElement('Row', { testID: `row:${props.machineId}`, working });
});

const Total = React.memo(function Total() {
    return React.createElement('Total', { testID: 'total', total: useMachineWorkingTotal() });
});

// Rows are a stable element, as an open surface's list is: only the scope re-renders on a new projection.
const rows = [React.createElement(Row, { key: 'a', machineId: 'a' }), React.createElement(Row, { key: 'b', machineId: 'b' }), React.createElement(Total, { key: 't' })];

describe('machine working counts scope', () => {
    it('re-renders only the row whose machine changed', async () => {
        const screen = await renderScreen(<MachineWorkingCountsScope counts={counts({ a: 1, b: 2 })}>{rows}</MachineWorkingCountsScope>);
        expect(screen.findByTestId('row:a')?.props.working).toBe(1);
        expect(screen.findByTestId('row:b')?.props.working).toBe(2);
        const before = { ...renders };

        // A session on machine a starts working; nothing on machine b changed.
        await screen.update(<MachineWorkingCountsScope counts={counts({ a: 2, b: 2 })}>{rows}</MachineWorkingCountsScope>);

        expect(screen.findByTestId('row:a')?.props.working).toBe(2);
        expect(screen.findByTestId('row:b')?.props.working).toBe(2);
        expect(screen.findByTestId('total')?.props.total).toBe(4);
        expect(renders.a).toBe(before.a! + 1);
        expect(renders.b).toBe(before.b);
    });

    it('reads a machine with no working session as zero', async () => {
        const screen = await renderScreen(<MachineWorkingCountsScope counts={counts({})}>{rows}</MachineWorkingCountsScope>);
        expect(screen.findByTestId('row:a')?.props.working).toBe(0);
    });
});
