import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useLaunchSelectionMachines } from '@/sync/store/hooks';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useNewSessionPlacementMachines } from './useNewSessionPlacementMachines';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const initial = storage.getState();
afterEach(() => storage.setState({ machines: initial.machines, machineListByServerId: initial.machineListByServerId,
    machineListStatusByServerId: initial.machineListStatusByServerId }));

describe('useNewSessionPlacementMachines', () => {
    it('does not subscribe to fleet details until a caller demands them, then opens current rows', async () => {
        const machine = createMachineFixture({ id: 'demand-machine' });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { 'home-a': [machine] },
            machineListStatusByServerId: { 'home-a': 'idle' } });
        let renders = 0;
        const hook = await renderHook(({ enabled }: Readonly<{ enabled: boolean }>) => {
            renders += 1;
            const activeMachines = useLaunchSelectionMachines(true, enabled);
            return useServerScopedMachineOptions({ allowedServerIds: enabled ? ['home-a'] : [], activeServerId: 'home-a', activeMachines });
        }, { initialProps: { enabled: false } });
        try {
            const mounted = renders;
            for (let index = 0; index < 5; index += 1) {
                const changed = { ...machine, metadata: { ...machine.metadata!, displayName: `Demand ${index}` } };
                await act(async () => storage.setState({ machines: { [machine.id]: changed },
                    machineListByServerId: { 'home-a': [changed] } }));
            }
            expect(renders - mounted).toBe(0);
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent()[0]?.machines[0]?.metadata?.displayName).toBe('Demand 4');
        } finally { await hook.unmount(); }
    });

    it('reads current inventory at placement intent without rendering for unrelated own or foreign Machine changes', async () => {
        const selected = createMachineFixture({ id: 'selected' });
        const other = createMachineFixture({ id: 'other' });
        storage.setState({ machines: { selected, other }, machineListByServerId: { 'home-a': [selected, other] },
            machineListStatusByServerId: { 'home-a': 'idle' } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useNewSessionPlacementMachines({ serverId: 'home-a', activeServerId: 'home-a' });
        });
        const read = () => {
            const current = hook.getCurrent();
            return typeof current === 'function' ? current() : current;
        };
        expect(read().map(machine => machine.id).sort()).toEqual(['other', 'selected']);
        const mounted = renders;
        try {
            for (let index = 0; index < 5; index += 1) {
                const changed = { ...other, metadata: { ...other.metadata!, displayName: `Other ${index}` } };
                await act(async () => storage.setState({ machines: { selected, other: changed },
                    machineListByServerId: { 'home-a': [selected, changed], 'home-b': [createMachineFixture({ id: `foreign-${index}` })] } }));
            }
            expect(renders - mounted).toBe(0);
            expect(read().find(machine => machine.id === other.id)?.metadata?.displayName).toBe('Other 4');
        } finally { await hook.unmount(); }
    });
});
