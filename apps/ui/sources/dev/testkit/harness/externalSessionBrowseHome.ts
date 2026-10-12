import { createMachineFixture } from '../fixtures/machineFixtures';
import { serveActionHomes } from './actionHomesHttpHarness';

/** Signed-in Homes and real Machine inventory beneath the Browse Action boundary. */
export async function serveExternalSessionBrowseHome(params: Parameters<typeof serveActionHomes>[0]) {
    const [{ publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability }, { getStorage }] = await Promise.all([
        import('@/sync/runtime/orchestration/appliedActiveServerRuntime'),
        import('@/sync/domains/state/storageStore'),
    ]);
    const home = await serveActionHomes(params);
    const focused = params.homes.at(-1)!;
    const serverId = home.homes[focused.key]!.id;
    const machines = ['machine-1', 'machine-2'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
    const storage = getStorage();
    storage.setState(state => ({ isDataReady: true, profile: { ...state.profile, id: focused.accountId },
        machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: Object.fromEntries(Object.values(home.homes).map(profile => [profile.id, machines])),
        machineListStatusByServerId: Object.fromEntries(Object.values(home.homes).map(profile => [profile.id, 'idle' as const])),
    }));
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: focused.serverUrl, generation: 0 });
    return { ...home, serverId, dispose() { publishAppliedActiveServerRuntimeAvailability(false); home.dispose(); } };
}
