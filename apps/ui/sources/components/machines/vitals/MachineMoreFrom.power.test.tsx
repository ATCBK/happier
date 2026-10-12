import * as React from 'react';
import { afterEach, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { buildMachineMoreFromFacts, MachineMoreFrom } from './MachineMoreFrom';

afterEach(() => standardCleanup());

it('shows a powered-off GPU in the existing accessible fact slot without a stale reading', async () => {
    const extras = { gpu: [{ name: 'Discrete GPU', powerState: 'off' as const, busyPct: 72, memUsedBytes: 1024, memTotalBytes: 2048 }] };
    const fact = buildMachineMoreFromFacts(extras).find((entry) => entry.key === 'gpu');
    expect(fact).toMatchObject({ value: t('common.off'), detail: 'Discrete GPU' });
    const screen = await renderScreen(<ItemList><MachineMoreFrom machineName="Studio" extras={extras} attention={null} /></ItemList>);
    expect(screen.findAll((node) => node.props.accessible === true && node.props.accessibilityLabel ===
        [fact!.label, fact!.value, fact!.detail].join(', ')).length).toBeGreaterThan(0);
});

it('keeps awake GPU zero real and names the off device in a mixed report', () => {
    const fact = buildMachineMoreFromFacts({ gpu: [{ name: 'Discrete GPU', powerState: 'off', busyPct: 72 },
        { name: 'Integrated GPU', busyPct: 0 }] }).find((entry) => entry.key === 'gpu');
    expect(fact?.value).toBe('0%');
    expect(fact?.detail).toContain(`Discrete GPU: ${t('common.off')}`);
});
