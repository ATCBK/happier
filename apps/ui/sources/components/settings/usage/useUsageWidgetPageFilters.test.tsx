import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { storage } from '@/sync/domains/state/storage';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { readUsageWidgetPageScope } from './usageWidgetPageContext';
import { useUsageWidgetPageContext } from './useUsageWidgetPageContext';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';

afterEach(standardCleanup);

it('keeps filter consumers quiet through Machine runtime changes while names, locks and missing choices stay live', async () => {
    const original = storage.getState();
    const machines = Array.from({ length: 150 }, (_, index) => createMachineFixture({ id: `machine-${index}` }));
    const scope = readUsageWidgetPageScope(normalizeUsageQuery({ machines: ['machine-0', 'machine-1', 'missing'] }));
    const counter = createRenderCommitCounter();
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: {}, machineListStatusByServerId: {} });
    const hook = await renderHook(() => {
        const page = useUsageWidgetPageContext({ authority: null,
            initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null, scope } });
        const filters = useUsageWidgetPageFilters(page, [], false);
        useRenderCommitCounter(counter);
        return filters.find(filter => filter.field === 'machines')!;
    });
    try {
        const expected = () => resolveMachineDisplayNames([
            ...Object.values(storage.getState().machines), { id: 'missing', absence: 'unlisted' as const },
        ]);
        const labels = () => new Map(hook.getCurrent().options.map(option => [option.id, option.label]));
        expect(labels().get('machine-0')).toBe(expected().get('machine-0'));
        expect(labels().get('machine-0')).not.toBe(labels().get('machine-1'));
        counter.reset();
        for (let index = 0; index < 20; index++) {
            await act(async () => {
                const current = storage.getState().machines;
                storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!, daemonStateVersion: index + 2 } } });
            });
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => {
            const current = storage.getState().machines;
            storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!,
                metadata: { ...current['machine-0']!.metadata!, displayName: 'Build box' } } } });
        });
        expect(labels().get('machine-0')).toBe('Build box');
        expect(counter.read().commits).toBeGreaterThan(0);
        await act(async () => {
            const current = storage.getState().machines;
            storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!, availability: { kind: 'locked', reason: 'decryption_failed' } } } });
        });
        expect(labels().get('machine-0')).toBe(expected().get('machine-0'));
        expect(labels().get('machine-0')).not.toBe('Build box');
        expect(labels().get('missing')).toBe(expected().get('missing'));
    } finally {
        await hook.unmount();
        storage.setState({ machines: original.machines, machineListByServerId: original.machineListByServerId,
            machineListStatusByServerId: original.machineListStatusByServerId });
    }
});
