import { afterAll, afterEach, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } =
    await import('@/sync/domains/machines/reachability/machineReachability');
const operations = await import('./machineExternalSessions');
const initial = storage.getState();
afterEach(() => { storage.setState(initial, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

it('retries the exact operation Machine after request failure, without redirecting a replaced identity or admitting locked content', async () => {
    const home = await network.addHome('https://external-operation-target.test', 'operation-account');
    network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    const machine = createMachineFixture({ id: 'origin', active: true, activeAt: Date.now() });
    const replacement = createMachineFixture({ id: 'replacement', active: true, activeAt: Date.now() });
    const publish = (row: typeof machine) => storage.setState({
        profileScope: { serverId: home.id, accountId: home.accountId }, machines: { [row.id]: row, [replacement.id]: replacement },
        machineListByServerId: { [home.id]: [row, replacement] }, machineListStatusByServerId: { [home.id]: 'idle' },
    });
    const reference = { machineId: machine.id, sessionId: 'session', operationId: 'operation', revision: 1 };
    const options = { serverId: home.id, accountId: home.accountId };
    network.respond(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET, { ok: false, error: { code: 'internal_error', message: 'fixture' } });
    network.respond(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME, { ok: false, error: { code: 'internal_error', message: 'fixture' } });
    publish(machine);
    recordMachineRequestFailed({ ...options, machineId: machine.id });
    await expect(operations.machineExternalSessionOperationStatus(reference, options)).resolves.toMatchObject({ ok: false });
    expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET))
        .toMatchObject([{ targetId: machine.id }]);
    for (const unavailable of [
        { ...machine, replacedByMachineId: replacement.id },
        { ...machine, revokedAt: 1 },
        { ...machine, availability: { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const } },
    ]) {
        publish(unavailable);
        const beforeRequests = network.requests.length;
        await expect(operations.machineExternalSessionOperationStatus(reference, options)).rejects.toThrow();
        await expect(operations.machineExternalSessionOperationResume(reference, options)).rejects.toThrow();
        expect(network.requests.length).toBe(beforeRequests);
    }
});
