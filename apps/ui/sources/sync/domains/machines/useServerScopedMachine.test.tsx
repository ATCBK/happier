import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useServerScopedMachine } from '@/sync/domains/state/storage';

it('keeps exact Home/Machine consumers quiet for fleet arrivals while publishing selected changes and removal', async () => {
    const store = getStorage();
    const previous = store.getState();
    const machines = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `selected-${index}` }));
    const otherHome = createMachineFixture({ id: machines[0]!.id, metadata: { ...machines[0]!.metadata!, homeDir: '/other-home' } });
    store.setState({ machineListByServerId: { 'home-a': machines, 'home-b': [otherHome] },
        machineListStatusByServerId: { 'home-a': 'idle', 'home-b': 'idle' } });
    let renders = 0;
    const hook = await renderHook(() => { renders += 1; return useServerScopedMachine('home-a', machines[0]!.id); });
    try {
        expect(hook.getCurrent()).toBe(machines[0]);
        renders = 0;
        await act(async () => store.setState(state => ({ machineListByServerId: { ...state.machineListByServerId,
            'home-a': machines.map((machine, index) => index === 99 ? { ...machine, metadataVersion: 2 } : machine),
            'home-b': [{ ...otherHome, metadataVersion: 2 }],
        } })));
        expect(renders).toBe(0);
        const selected = { ...machines[0]!, metadata: { ...machines[0]!.metadata!, homeDir: '/current-home' } };
        await act(async () => store.setState(state => ({ machineListByServerId: { ...state.machineListByServerId,
            'home-a': [selected, ...machines.slice(1)],
        } })));
        expect(hook.getCurrent()).toBe(selected);
        expect(renders).toBe(1);
        await act(async () => store.setState(state => ({ machineListByServerId: { ...state.machineListByServerId, 'home-a': [] } })));
        expect(hook.getCurrent()).toBeNull();
    } finally {
        await hook.unmount();
        store.setState(previous);
    }
});
