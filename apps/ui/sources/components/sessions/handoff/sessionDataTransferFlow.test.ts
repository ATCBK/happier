import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';
import type { SessionHandoffPickerModalProps } from './SessionHandoffPickerModal';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => {
    const { createServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcModuleMock({ importOriginal, overrides: { machineRpcWithServerScope: machineRpc } });
});
const modal = createModalModuleMock();
installSessionHandoffCommonModuleMocks({ storage: async (importOriginal) => importOriginal(), modal: async () => modal.module });
vi.doUnmock('@/constants/Typography');
let cleanup = () => {};
afterEach(() => cleanup());

it('keeps the dialog after no-copy refusal and sends only the corrected transfer choice on retry', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { sync } = await import('@/sync/sync');
    const previousState = storage.getState();
    const previousAccountId = sync.serverID;
    cleanup = () => { storage.setState(previousState, true); sync.serverID = previousAccountId; };
    sync.serverID = 'handoff-test-account';
    let nextModalId = 0;
    modal.spies.show.mockImplementation(() => `handoff-modal-${++nextModalId}`);
    storage.getState().applySessions([createSessionFixture({ id: 'handoff-test-session', active: false, metadata: { ...createSessionFixture().metadata!, machineId: 'handoff-test-source', path: '/project', flavor: 'claude' } })]);
    machineRpc.mockResolvedValue({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Native session unavailable' });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { runSessionHandoffPickerFlow } = await import('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow');
    const flow = runSessionHandoffPickerFlow({ execute: createDefaultActionExecutor().execute, sessionId: 'handoff-test-session', sourceMachineId: 'handoff-test-source', serverId: null, placement: 'session_info' });
    await vi.waitFor(() => expect(modal.spies.show).toHaveBeenCalled());
    const config = modal.spies.show.mock.calls[0]?.[0] as { props: Omit<SessionHandoffPickerModalProps, 'onClose' | 'setChrome'> };
    config.props.onResolve({ targetMachineId: 'handoff-test-target', stateTransfer: 'existing' });
    await expect(flow).resolves.toMatchObject({ ok: false, handled: true });
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START, payload: expect.objectContaining({ stateTransfer: 'existing' }) }));
    expect(modal.spies.update).toHaveBeenCalledWith('handoff-modal-1', { inlineErrorCode: 'existing_session_state_unavailable' });
    expect(modal.spies.hide).not.toHaveBeenCalledWith('handoff-modal-1');
    config.props.onResolve({ targetMachineId: 'handoff-test-target', stateTransfer: 'transfer' });
    await vi.waitFor(() => expect(machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_START)).toHaveLength(2));
    expect(machineRpc.mock.lastCall?.[0].payload.stateTransfer).not.toBe('existing');
    expect(modal.spies.update).toHaveBeenCalledWith('handoff-modal-1', { inlineErrorCode: null });
    config.props.onResolve(null);
});
