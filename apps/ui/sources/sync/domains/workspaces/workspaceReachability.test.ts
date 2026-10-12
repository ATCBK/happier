import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { isWorkspaceScopeReachableFromState } from './workspaceReachability';

describe('workspaceReachability', () => {
    it('uses settled Machine inventory independently of Account readiness', () => {
        const machine = createMachineFixture({ id: 'independent-machine', active: true, activeAt: Date.now() });
        const state = {
            isDataReady: false,
            machines: { [machine.id]: machine },
            machineListByServerId: {},
            machineListStatusByServerId: { 'server-a': 'idle' as const },
        };
        const scope = { serverId: 'server-a', machineId: machine.id, rootPath: '/repo' };
        expect(isWorkspaceScopeReachableFromState(state, scope, 'server-a', { serverId: 'server-a', accountId: 'workspace-account' })).toBe(true);
        for (const status of ['loading', 'error', 'signedOut'] as const) {
            expect(isWorkspaceScopeReachableFromState({ ...state,
                machineListStatusByServerId: { 'server-a': status } }, scope, 'server-a', { serverId: 'server-a', accountId: 'workspace-account' })).toBe(false);
        }
    });

    it('honors settled exact-machine absence instead of borrowing a stale active row', () => {
        const stale = createMachineFixture({ id: 'machine-gone', active: true, activeAt: Date.now() });
        const other = createMachineFixture({ id: 'machine-other', active: true, activeAt: Date.now() });
        expect(isWorkspaceScopeReachableFromState({
            machines: { [stale.id]: stale },
            machineListByServerId: { 'server-a': [other] }, machineListStatusByServerId: { 'server-a': 'idle' },
        }, { serverId: 'server-a', machineId: stale.id, rootPath: '/repo' }, 'server-a', { serverId: 'server-a', accountId: 'workspace-account' })).toBe(false);
    });

    it('requires the exact server-scoped machine to be currently online', () => {
        const activeMachine = createMachineFixture({ id: 'shared-machine', active: true, activeAt: Date.now() });
        const offlineOtherServerMachine = createMachineFixture({ id: 'shared-machine', active: false, activeAt: 0 });
        const state = {
            machines: { shared: activeMachine },
            machineListByServerId: { 'server-b': [offlineOtherServerMachine] },
            machineListStatusByServerId: { 'server-a': 'idle' as const, 'server-b': 'idle' as const },
        };

        expect(isWorkspaceScopeReachableFromState(state, {
            serverId: 'server-a',
            machineId: 'shared-machine',
            rootPath: '/repo',
        }, 'server-a', { serverId: 'server-a', accountId: 'workspace-account' })).toBe(true);
        expect(isWorkspaceScopeReachableFromState(state, {
            serverId: 'server-b',
            machineId: 'shared-machine',
            rootPath: '/repo',
        }, 'server-a', { serverId: 'server-b', accountId: 'workspace-account' })).toBe(false);
    });
});
