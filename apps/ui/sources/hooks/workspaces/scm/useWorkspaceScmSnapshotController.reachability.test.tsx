import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { useWorkspaceScmSnapshotController } from './useWorkspaceScmSnapshotController';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const boundary = vi.hoisted(() => ({ request: vi.fn(async () => new Promise<never>(() => {})) }));
// Machine transport is the network boundary; the controller, presence and SCM owners stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.request,
}));

const initial = storage.getState();
afterEach(async () => {
    await standardCleanup();
    storage.setState(initial, true);
    projectManager.clear();
    boundary.request.mockClear();
    await home.reset();
});

it('skips a known unreachable checkout wait, preserves its cache and retries after presence recovers', async () => {
    const serverId = await home.addHome({ name: 'SCM Home', serverUrl: 'https://scm-reachability.test', accountId: 'alice' });
    const scope = { serverId, machineId: 'machine-a', rootPath: '/repo' };
    const machine = createMachineFixture({ id: scope.machineId, active: false });
    storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'alice' },
        machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
    const snapshot = { projectKey: 'machine-a:/repo', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'cached-branch', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } };
    // An unbound credential scope is deliberately unknown, not offline. Keep
    // the controller inactive until its real presence subscription knows this checkout.
    const hook = await renderHook((requestedScope: typeof scope | null) => ({
        ...useWorkspaceScmSnapshotController(requestedScope),
        presence: useMachinePresenceSummary(scope.serverId, scope.machineId),
    }), { initialProps: null as typeof scope | null });
    await waitForHomeGovernance(() => expect(hook.getCurrent().presence.reachability).toBe('unreachable'));
    await hook.rerender(scope);
    await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ loading: false, error: { errorCode: 'machine_offline' }, snapshot: null }));
    expect(boundary.request).not.toHaveBeenCalled();
    act(() => storage.getState().updateWorkspaceScmSnapshot(scope, snapshot));
    expect(hook.getCurrent()).toMatchObject({ loading: false, error: { errorCode: 'machine_offline' },
        snapshot: { branch: { head: 'cached-branch' } } });
    expect(boundary.request).not.toHaveBeenCalled();
    await act(async () => { await hook.getCurrent().refresh(); });
    expect(boundary.request).not.toHaveBeenCalled();
    const online = { ...machine, active: true, activeAt: Date.now() };
    act(() => storage.setState({ machines: { [online.id]: online }, machineListByServerId: { [scope.serverId]: [online] } }));
    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(hook.getCurrent().loading).toBe(true);
    expect(boundary.request).toHaveBeenCalled();
});
