import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Only the authenticated Machine connection and native presentation leave the real Action path.
const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { executeMachineProcessesActionV1 } = await import('./machineProcessesActions');
const { Modal } = await import('@/modal');
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    boundary.rpc.mockReset().mockResolvedValue({ status: 'ended', outcomes: [{ ref: 'process-ref', outcome: 'ended' }] });
    vi.mocked(Modal.confirm).mockClear().mockResolvedValue(false);
    serverId = await homes.addHome({ name: 'Processes', serverUrl: 'https://process-action.test', accountId: 'owner', currentAccount: true });
});
afterEach(async () => { await homes.reset(); });

it('uses rich presentation only when the real Action policy asks, and dispatches once when Allowed', async () => {
    const confirmation = vi.fn(async () => false);
    const input = { machineId: 'machine', targets: [{ ref: 'process-ref', expect: { level: 'not_happier' as const } }], tree: false };
    const scope = { serverId, expectedAccountId: 'owner', confirmation };
    expect(await executeMachineProcessesActionV1('machines.processes.kill', input, scope))
        .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(confirmation).toHaveBeenCalledOnce();
    expect(Modal.confirm).not.toHaveBeenCalled();
    expect(boundary.rpc).not.toHaveBeenCalled();
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.processes.kill': ['ui'] } }),
    } }, version: 1 } });
    expect(await executeMachineProcessesActionV1('machines.processes.kill', input, scope)).toMatchObject({ ok: true, result: { status: 'ended' } });
    expect(confirmation).toHaveBeenCalledOnce();
    expect(boundary.rpc).toHaveBeenCalledOnce();
});
