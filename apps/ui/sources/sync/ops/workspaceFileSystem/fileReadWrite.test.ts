import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadDaemonWorkspaceFileFromReaderSpy = vi.hoisted(() => vi.fn());
const runTransferFinalizeRecoveryMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: vi.fn(),
    callDaemonWorkspaceWriteFileRpc: vi.fn(),
    uploadDaemonWorkspaceFileFromReader: (...args: unknown[]) => uploadDaemonWorkspaceFileFromReaderSpy(...args),
}));

vi.mock('@/components/transfers/recovery/runTransferFinalizeRecovery', () => ({
    runTransferFinalizeRecovery: (...args: unknown[]) => runTransferFinalizeRecoveryMock(...args),
}));

const { workspaceWriteFile } = await import('./fileReadWrite');

describe('workspaceWriteFile', () => {
    beforeEach(() => {
        uploadDaemonWorkspaceFileFromReaderSpy.mockReset();
        runTransferFinalizeRecoveryMock.mockReset();
    });

    it('finalizes a retained large write without starting a second upload', async () => {
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            isActionable: () => true,
            invoke: vi.fn(),
        };
        uploadDaemonWorkspaceFileFromReaderSpy.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        runTransferFinalizeRecoveryMock.mockResolvedValueOnce({
            status: 'finalized',
            response: {
                success: true,
                path: '/repo/large.txt',
                sizeBytes: 256 * 1024 + 1,
                sha256: 'sha256',
            },
        });
        const result = await workspaceWriteFile(
            { machineId: 'machine-1', rootPath: '/repo', serverId: 'server-1' },
            'large.txt',
            'x'.repeat(256 * 1024 + 1),
        );

        expect(result).toEqual({ success: true, hash: 'sha256' });
        expect(uploadDaemonWorkspaceFileFromReaderSpy).toHaveBeenCalledTimes(1);
        expect(runTransferFinalizeRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({ recovery }));
    });
});
