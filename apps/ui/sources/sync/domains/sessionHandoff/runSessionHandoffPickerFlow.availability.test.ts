import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';
import { runSessionHandoffPickerFlow } from './runSessionHandoffPickerFlow';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

function chooseTarget() {
    const props: unknown = vi.mocked(Modal.show).mock.calls[0]?.[0].props;
    if (!props || typeof props !== 'object' || !('onResolve' in props) || typeof props.onResolve !== 'function') {
        throw new Error('Expected the real handoff picker at the native Modal boundary');
    }
    props.onResolve({ targetMachineId: 'target', workspaceAction: { kind: 'none' } });
}

describe('available session handoff entry', () => {
    const initial = storage.getState();
    beforeEach(async () => {
        // The picker submission holds the real sync user-request lease.
        await loadSyncSingletonForTests();
        vi.mocked(Modal.show).mockClear();
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
    });
    afterEach(() => { standardCleanup(); storage.setState(initial, true); });

    it('surfaces the actual unavailability reason and takes no action without opening a picker or transferring', async () => {
        const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: false, errorCode: 'unexpected', error: 'Unexpected transfer' }));
        const availability = resolveSessionHandoffUiAvailability({ sessionId: 'session-a', serverId: 'home-a',
            session: createSessionFixture({ id: 'session-a', serverId: 'home-a' }),
            sessionHandoffFeatureEnabled: true, runtimeAvailability: 'unavailable',
            serverSnapshot: { status: 'ready', features: { capabilities: {}, features: {
                sessions: { enabled: true, handoff: { enabled: true } },
                machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } },
            } } },
        });
        expect(availability).toEqual({ available: false, reason: 'runtime_direct_peer_unavailable' });
        const result = runSessionHandoffPickerFlow({ execute, sessionId: 'session-a', serverId: 'home-a',
            sourceMachineId: 'source', placement: 'session_info', availability,
        });
        // Settle the old behavior's picker, so a missing admission check fails an assertion, not a timeout.
        vi.mocked(Modal.show).mock.calls[0]?.[0].onRequestClose?.();
        // The flow takes no action; the reason is the resolved availability asserted above.
        await expect(result).resolves.toBeNull();
        expect(Modal.show).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it('keeps an admitted request pending and returns an unknown Action outcome without claiming completion', async () => {
        let complete!: (result: ActionExecuteResult) => void;
        const execute = vi.fn(() => new Promise<ActionExecuteResult>(resolve => { complete = resolve; }));
        const result = runSessionHandoffPickerFlow({ execute, sessionId: 'session-a', serverId: 'home-a',
            sourceMachineId: 'source', placement: 'session_info', availability: { available: true, reason: 'available' },
        });
        let settled = false;
        void result.then(() => { settled = true; });
        chooseTarget();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        const unknown = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'rpc_request_outcome_unknown', error: 'Outcome unknown' });
        complete(unknown);
        await expect(result).resolves.toEqual(unknown);
    });
});
