import { afterEach, expect, it } from 'vitest';

import { createMachineFixture, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';

import { useExecutionRunMachineName } from './useExecutionRunMachineName';

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); });

it('names the Run machine from its Home inventory rather than a legacy display projection', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const machine = createMachineFixture({ id: 'run-machine', metadata: { ...createMachineFixture().metadata!, displayName: 'Build computer' } });
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] }, machineDisplayById: {} });
    const hook = await renderHook(() => useExecutionRunMachineName(createSessionFixture({ metadata: { ...createSessionFixture().metadata!, machineId: machine.id } })));
    expect(hook.getCurrent()).toEqual({ machineId: machine.id, name: 'Build computer' });
});

it('reads the current Session owner view instead of assuming machine identity lives in shared metadata', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    const machine = createMachineFixture({ id: 'owner-machine', metadata: { ...createMachineFixture().metadata!, host: 'build-computer' } });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    const session = createSessionFixture({ metadataLayoutVersion: 1, metadata: null,
        ownerMetadataView: { ...createSessionFixture().metadata!, machineId: machine.id, host: 'recorded-computer' } });
    const hook = await renderHook(() => useExecutionRunMachineName(session, serverId));
    expect(hook.getCurrent()).toEqual({ machineId: machine.id, name: 'build-computer' });
});

it('uses the exact Home and keeps the recorded host if that Home has no readable name', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    const active = createMachineFixture({ id: 'same-machine', metadata: { ...createMachineFixture().metadata!, displayName: 'Other Home computer' } });
    const exact = createMachineFixture({ id: active.id, metadata: { ...active.metadata!, displayName: 'Exact Home computer' } });
    storage.setState({ machines: { [active.id]: active }, machineListByServerId: { [serverId]: [active], 'exact-home': [exact] } });
    const hook = await renderHook(() => useExecutionRunMachineName(createSessionFixture({ metadata: { ...createSessionFixture().metadata!, machineId: active.id, host: 'recorded.local' } }), 'exact-home'));
    expect(hook.getCurrent().name).toBe('Exact Home computer');
    await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [active], 'exact-home': [{ ...exact, metadata: null }] } }); });
    expect(hook.getCurrent().name).toBe('recorded.local');
});

it('does not rerender a Run when its Machine only publishes presence', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'account-1' });
    const machine = createMachineFixture({ id: 'run-machine', metadata: { ...createMachineFixture().metadata!, displayName: 'Build computer' } });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    const session = createSessionFixture({ metadata: { ...createSessionFixture().metadata!, machineId: machine.id } });
    let renders = 0;
    const hook = await renderHook(() => { renders++; return useExecutionRunMachineName(session, serverId); });
    const baseline = renders;
    await act(async () => {
        const heartbeat = { ...machine, activeAt: machine.activeAt + 1 };
        storage.setState({ machines: { [machine.id]: heartbeat }, machineListByServerId: { [serverId]: [heartbeat] } });
    });
    expect(hook.getCurrent().name).toBe('Build computer');
    expect(renders).toBe(baseline);
});
