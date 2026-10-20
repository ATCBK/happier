import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { Modal } from '@/modal';
import type { IModal } from '@/modal';
import { TransferFinalizeRecoveryModal } from '@/components/transfers/recovery/TransferFinalizeRecoveryModal';
import { workspaceWriteFile } from './fileReadWrite';

type ModalShowInput = Parameters<IModal['show']>[0];
let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | undefined;

function requireModalProps(input: ModalShowInput | undefined): NonNullable<ModalShowInput['props']> {
    if (!input?.props) throw new Error('Expected workspace finalize recovery modal props');
    return input.props;
}

afterEach(async () => {
    await harness?.reset();
    harness = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('workspaceWriteFile finalize recovery composition', () => {
    it('waits for explicit same-session retries and re-presents an indeterminate finalize until terminal success', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES', '4');
        harness = await createWorkspaceFileDownloadHarness();
        harness.requireNextUploadFinalizeRecovery();
        const boundary = harness;
        const prompts: ModalShowInput[] = [];
        const originalShow = Modal.show;
        vi.spyOn(Modal, 'show').mockImplementation(config => {
            if (config.component !== TransferFinalizeRecoveryModal) return originalShow(config);
            prompts.push(config);
            return 'workspace-finalize-recovery';
        });

        const result = workspaceWriteFile(boundary.scope, 'large.txt', 'hello');
        const prepareRequests = () => boundary.rpcRequests.filter(request => request.method === 'daemon.filesystem.upload');
        const transferRequests = () => boundary.requests.filter(request => new URL(request.url).pathname.startsWith('/machine-transfers/direct/imports/'));
        const finalizeRequests = () => transferRequests().filter(request => request.url.endsWith('/finalize'));
        const chunkRequests = () => transferRequests().filter(request => request.url.endsWith('/chunks/0'));

        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        expect(finalizeRequests()).toHaveLength(1);
        expect(prepareRequests()).toHaveLength(1);
        expect(chunkRequests()).toHaveLength(1);
        expect(boundary.uploads[0]).toMatchObject({ bytes: new TextEncoder().encode('hello'), finalized: false, finalizeAttempts: 1 });

        boundary.interruptNextUploadFinalize();
        requireModalProps(prompts[0]).onResolve('retry_finalize');
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        expect(finalizeRequests()).toHaveLength(2);
        expect(prepareRequests()).toHaveLength(1);
        expect(chunkRequests()).toHaveLength(1);
        await Promise.resolve();
        expect(finalizeRequests()).toHaveLength(2);

        requireModalProps(prompts[1]).onResolve('retry_finalize');
        // The canonical HTTP boundary hashes the bytes that actually arrived.
        await expect(result).resolves.toEqual({ success: true, hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
        expect(finalizeRequests()).toHaveLength(3);
        expect(prompts).toHaveLength(2);
        expect(prepareRequests()).toHaveLength(1);
        expect(boundary.uploads).toHaveLength(1);
        expect(boundary.uploads[0]).toMatchObject({ finalized: true, aborted: false, finalizeAttempts: 3 });
        const baseUrl = chunkRequests()[0]!.url.slice(0, -'/chunks/0'.length);
        expect(new URL(baseUrl).pathname).toBe(`/machine-transfers/direct/imports/${boundary.uploads[0]!.uploadId}`);
        expect(transferRequests().map(({ method, url }) => ({ method, url }))).toEqual([
            { method: 'PUT', url: `${baseUrl}/chunks/0` },
            { method: 'POST', url: `${baseUrl}/finalize` },
            { method: 'POST', url: `${baseUrl}/finalize` },
            { method: 'POST', url: `${baseUrl}/finalize` },
        ]);

        requireModalProps(prompts[1]).onResolve('retry_finalize');
        await Promise.resolve();
        expect(finalizeRequests()).toHaveLength(3);
        expect(prompts).toHaveLength(2);
    });
});
