import { describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const updatePendingRequestedAction = vi.hoisted(() => vi.fn(async () => undefined));
const isSessionTargetRemoteToActiveServer = vi.hoisted(() => vi.fn(() => true));
const sessionSwitch = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/sync/ops', () => ({ ensureSessionRuntimeForPendingInput: vi.fn(), sessionSwitch }));
vi.mock('@/sync/sync', () => ({
    sync: {
        abortSession: vi.fn(),
        updatePendingRequestedAction,
        enqueuePendingMessage: vi.fn(),
        encryption: { getMachineEncryption: vi.fn() },
        refreshSessionForSubmit: vi.fn(),
        isSessionTargetRemoteToActiveServer,
        sendMessage: vi.fn(),
    },
}));

// Load the real owner after boundary installation, outside the case's runtime deadline.
const { createSyncBackedSubmitPort } = await import('./syncBackedSubmitPort');

describe('createSyncBackedSubmitPort', () => {
    it('does not admit an online-only wake after the exact Home and Account request failed', async () => {
        const previousState = storage.getState();
        const scope = { serverId: 'server-submit', accountId: 'account-submit' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'machine-submit', active: true, activeAt: Date.now() });
        try {
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
            recordMachineRequestFailed({ ...scope, machineId: machine.id });
            const port = createSyncBackedSubmitPort();
            const otherAccount = { ...accountLifetime, scope: { ...scope, accountId: 'other-account' } };
            expect(port.isMachineReachable?.(machine.id, { serverId: scope.serverId, accountLifetime: otherAccount })).toBe(true);
            expect(port.isMachineReachable?.(machine.id, { serverId: scope.serverId, accountLifetime })).toBe(false);
            recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
            expect(port.isMachineReachable?.(machine.id, { serverId: scope.serverId, accountLifetime })).toBe(true);
            expect(port.isMachineReachable?.(machine.id, { serverId: 'another-home', accountLifetime })).toBe(false);
            expect(port.isMachineReachable?.(machine.id, { serverId: scope.serverId,
                accountLifetime: { ...accountLifetime, isCurrent: () => false } })).toBe(false);
        } finally {
            storage.setState(previousState);
            clearMachineRequestReachabilityForTest();
        }
    });
    it('forwards the canonical Pending row action mutation', async () => {
        const port = createSyncBackedSubmitPort();
        const accountLifetime = {
            scope: { serverId: 'server-1', accountId: 'account-1' },
            isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
        };
        await port.updatePendingRequestedAction?.(
            'session-1',
            'local-1',
            { v: 1, kind: 'steer_now' },
            { serverId: 'server-1', accountLifetime },
        );
        expect(updatePendingRequestedAction).toHaveBeenCalledWith(
            'session-1',
            'local-1',
            { v: 1, kind: 'steer_now' },
            { serverId: 'server-1', accountLifetime },
        );
        expect(port.isSessionTargetRemoteToActiveServer('session-1')).toBe(true);
        expect(isSessionTargetRemoteToActiveServer).toHaveBeenCalledWith('session-1');

        await port.switchSessionControlToRemote?.('session-1', {
            serverId: 'server-1',
            accountLifetime,
        });
        expect(sessionSwitch).toHaveBeenCalledWith('session-1', 'remote', {
            serverId: 'server-1',
            accountLifetime,
        });
    });
});
