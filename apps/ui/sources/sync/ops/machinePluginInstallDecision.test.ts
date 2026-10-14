import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));
describe('machinePluginInstallDecision', () => {
    it('treats a workspace project-trust acceptance as a successful terminal decision', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            kind: 'projectTrustAccepted',
            projectRoot: '/workspace/project',
        });
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');
        await expect(machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'workspace-trust-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => [],
            },
        })).resolves.toEqual({
            supported: true,
            outcome: { kind: 'projectTrustAccepted', detail: null },
        });
    });

    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        vi.restoreAllMocks();
    });

    it('preserves the committed daemon receipt after the authenticated human decision', async () => {
        const committed = { kind: 'committed', pluginId: 'acme.plugin', desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1', pendingSurfaces: [] };
        machineRpcWithServerScopeMock.mockResolvedValueOnce(committed);
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        await expect(machinePluginInstallDecision('machine-1', {
            serverId: 'server-a',
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => [{ accessId: 'workspace', selected: false }],
            },
        })).resolves.toEqual({
            supported: true,
            outcome: { kind: 'committed', detail: null, change: committed },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                optionalSelections: [{ accessId: 'workspace', selected: false }],
            },
        }));
    });

    it('preserves a failed exact-machine transport reason for the visible caller', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(
            new Error('Machine RPC direct HTTP response failed'),
            { code: 'MACHINE_RPC_DIRECT_HTTP_FAILED' },
        ));
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        await expect(machinePluginInstallDecision('machine-1', {
            serverId: 'server-a',
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => [],
            },
        })).resolves.toEqual({
            supported: false,
            reason: 'error',
            detail: 'Machine RPC direct HTTP response failed',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.plugins.install.review.decide',
            payload: expect.objectContaining({
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
            }),
        }));
    });

    it('turns a declined confirmation into cancellation without affirmative evidence', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'cancelled' });
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        await machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => null,
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'cancel',
            },
        }));
    });

    it('withholds the private decision when authority changes while confirmation is open', async () => {
        let resolveConfirmation!: (selections: readonly Readonly<{ accessId: string; selected: boolean }>[]) => void;
        const confirmPresentUser = vi.fn(async () => await new Promise<
            readonly Readonly<{ accessId: string; selected: boolean }>[]
        >((resolve) => {
            resolveConfirmation = resolve;
        }));
        let authorityCurrent = true;
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        const resultPromise = machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => authorityCurrent,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser,
            },
        });
        await vi.waitFor(() => expect(confirmPresentUser).toHaveBeenCalledOnce());
        authorityCurrent = false;
        resolveConfirmation([]);

        await expect(resultPromise).resolves.toEqual({
            supported: false,
            reason: 'error',
            detail: 'Authenticated plugin install authority changed during present-user confirmation',
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
