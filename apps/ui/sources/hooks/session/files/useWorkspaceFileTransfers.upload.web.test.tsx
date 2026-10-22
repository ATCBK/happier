import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';

import { createDeferred, renderHook } from '@/dev/testkit';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import type { TransferFinalizeRecoveryAction } from '@/sync/domains/transfers/runtime/transferRuntime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');
const { TransferFinalizeRecoveryModal } = await import('@/components/transfers/recovery/TransferFinalizeRecoveryModal');
const { Modal } = await import('@/modal');
const originalModalShow = vi.mocked(Modal.show).getMockImplementation();

describe('useWorkspaceFileTransfers upload pipeline', () => {
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;

    beforeEach(async () => {
        vi.clearAllMocks();
        harness = await createWorkspaceFileDownloadHarness();
        harness.setStatResponse({ success: true, exists: false });
    });

    afterEach(async () => {
        await act(async () => { await harness?.reset(); });
        vi.restoreAllMocks();
        if (originalModalShow) vi.mocked(Modal.show).mockImplementation(originalModalShow);
    });

    function uploadInput(file = new File(['hello'], 'hello.txt', { type: 'text/plain' })) {
        return {
            destinationDir: 'workspace/files',
            entries: [{ kind: 'web' as const, file, relativePath: 'hello.txt' }],
        };
    }

    async function renderTransfers(options: Omit<Parameters<typeof useWorkspaceFileTransfers>[0], 'workspaceScope'> = {}) {
        return await renderHook(() => useWorkspaceFileTransfers({ workspaceScope: harness.scope, ...options }));
    }

    function observeRecoveryPrompt() {
        const prompt = createDeferred<(action: TransferFinalizeRecoveryAction) => void>();
        vi.mocked(Modal.show).mockImplementation(config => {
            if (config.component === TransferFinalizeRecoveryModal) {
                // Modal presentation is the UI boundary; the continuation and its retry stay real.
                const onResolve: unknown = Reflect.get(config.props ?? {}, 'onResolve');
                if (typeof onResolve !== 'function') throw new Error('Recovery prompt has no public choice handler');
                prompt.resolve(action => onResolve(action));
                return 'workspace-upload-recovery';
            }
            if (!originalModalShow) throw new Error('Missing canonical Modal presentation fixture');
            return originalModalShow(config);
        });
        return prompt.promise;
    }

    it('uploads the actual browser file through the admitted encrypted bulk pipeline', async () => {
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual({ ok: true });
        });

        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({
            input: {
                rootPath: '/repo', path: '/repo/workspace/files/hello.txt', overwrite: false,
                source: { sourceId: expect.any(String), sizeBytes: 5 },
            },
            bytes: new TextEncoder().encode('hello'), finalized: true, aborted: false, finalizeAttempts: 1,
        }));
        expect(hook.getCurrent().uploadState).toEqual({ status: 'done', totalFiles: 1, totalBytes: 5 });
        expect(harness.rpcRequests).toContainEqual(expect.objectContaining({
            machineId: harness.scope.machineId, method: RPC_METHODS.STAT_FILE,
            payload: { path: '/repo/workspace/files/hello.txt' },
        }));
    });

    it('keeps cold upload preparation alive beyond the byte-request deadline', async () => {
        const hook = await renderTransfers();
        const preparation = harness.deferNextUploadPreparation();
        let pending: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']> | undefined;
        let settled = false;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            await act(async () => {
                pending = hook.getCurrent().startUploads(uploadInput()).finally(() => { settled = true; });
                await vi.waitFor(() => expect(harness.requests.some(request => request.url.endsWith('/v1/actions/daemon.filesystem.upload'))).toBe(true));
                await preparation.entered;
            });
            const request = harness.requests.find(request => request.url.endsWith('/v1/actions/daemon.filesystem.upload'));
            expect(request?.signal).toBeDefined();
            await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
            expect(request?.signal?.aborted).toBe(false);
            expect(hook.getCurrent().uploadState.status).toBe('uploading');
            await act(async () => {
                preparation.release();
                await vi.waitFor(() => expect(settled).toBe(true));
                await expect(pending).resolves.toEqual({ ok: true });
            });
            expect(harness.uploads[0]).toMatchObject({ finalized: true, aborted: false });
            expect(hook.getCurrent().uploadState.status).toBe('done');
        } finally {
            preparation.release();
            await act(async () => { await pending; });
            vi.useRealTimers();
            await hook.unmount();
        }
    });

    it('keeps the idle transfer API stable when the same workspace scope is passed again', async () => {
        const hook = await renderHook(
            (props: Parameters<typeof useWorkspaceFileTransfers>[0]) => useWorkspaceFileTransfers(props),
            { initialProps: { workspaceScope: harness.scope } },
        );
        const initialApi = hook.getCurrent();

        await hook.rerender({ workspaceScope: { ...harness.scope } });

        expect(hook.getCurrent()).toBe(initialApi);
    });

    it('surfaces a rejected finalize as an error instead of a canceled state', async () => {
        harness.failNextUploadFinalize();
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual({
                ok: false, error: 'Direct import request failed with status 409',
            });
        });

        expect(hook.getCurrent().uploadState).toEqual({ status: 'error', error: 'Direct import request failed with status 409', reason: 'other' });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({ finalized: false, aborted: true, finalizeAttempts: 1 }));
    });

    it('surfaces a thrown browser source failure instead of rejecting the batch', async () => {
        const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
        vi.spyOn(file, 'slice').mockImplementation(() => { throw new Error('Upload source reader exploded'); });
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput(file))).resolves.toEqual({
                ok: false, error: 'Upload source reader exploded',
            });
        });

        expect(hook.getCurrent().uploadState).toEqual({ status: 'error', error: 'Upload source reader exploded', reason: 'other' });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({ bytes: new Uint8Array(), finalized: false, aborted: true }));
    });

    it('settles an abort that escapes preflight as a quiet cancellation, and any other escape as an error, never a rejection', async () => {
        harness.setStatResponse({ success: true, exists: true });
        for (const [thrown, expected, state] of [
            [new DOMException('signal is aborted without reason', 'AbortError'), { ok: false, error: 'Upload canceled', canceled: true }, { status: 'canceled' }],
            [new Error('Conflict prompt exploded'), { ok: false, error: 'Conflict prompt exploded' }, { status: 'error', error: 'Conflict prompt exploded', reason: 'other' }],
        ] as const) {
            const hook = await renderTransfers({ onResolveUploadConflicts: async () => { throw thrown; } });
            await act(async () => {
                await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual(expected);
            });
            expect(hook.getCurrent().uploadState).toEqual(state);
            expect(harness.uploads).toHaveLength(0);
        }
    });

    it('keeps the first failure of a batch: the abort it raises in a sibling upload is not a second failure to word', async () => {
        const broken = new File(['broken'], 'broken.txt', { type: 'text/plain' });
        vi.spyOn(broken, 'slice').mockImplementation(() => { throw new Error('Upload source reader exploded'); });
        const sibling = new File(['hello'], 'sibling.txt', { type: 'text/plain' });
        const hook = await renderTransfers();
        // The sibling is mid-flight (its first chunk is held) when the broken file fails and the batch aborts.
        const chunk = harness.deferNextUploadChunk();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']>;
        await act(async () => {
            pending = hook.getCurrent().startUploads({ destinationDir: 'workspace/files', entries: [
                { kind: 'web', file: broken, relativePath: 'broken.txt' }, { kind: 'web', file: sibling, relativePath: 'sibling.txt' },
            ] });
            await new Promise(resolve => setTimeout(resolve, 20));
            chunk.release();
            await pending;
        });
        await expect(pending).resolves.toEqual({ ok: false, error: 'Upload source reader exploded' });
        expect(hook.getCurrent().uploadState).toEqual({ status: 'error', error: 'Upload source reader exploded', reason: 'other' });
    });

    it('words a machine that stops answering as unreachable, never as the transport\'s own abort text', async () => {
        const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
        // An abort nothing the person did caused (the transport's own deadline, a retired scope): its text is the browser's, not ours.
        vi.spyOn(file, 'slice').mockImplementation(() => { throw new DOMException('signal is aborted without reason', 'AbortError'); });
        const hook = await renderTransfers();
        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput(file))).resolves.toMatchObject({ ok: false });
        });
        expect(hook.getCurrent().uploadState).toMatchObject({ status: 'error', reason: 'unreachable' });
        await act(async () => { hook.getCurrent().dismissUploadFailure(); });
        expect(hook.getCurrent().uploadState).toEqual({ status: 'idle' });
    });

    it('settles at once, as the Machine not answering, when the preflight read of the destination gets no answer, instead of going on to a second long attempt', async () => {
        harness.setStatResponse({ success: false, error: 'Machine RPC call timeout', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE });
        const hook = await renderTransfers();
        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toMatchObject({ ok: false });
        });
        expect(hook.getCurrent().uploadState).toMatchObject({ status: 'error', reason: 'unreachable' });
        expect(harness.uploads).toHaveLength(0);
        expect(harness.requests.some(request => request.url.endsWith('/v1/actions/daemon.filesystem.upload'))).toBe(false);
    });

    it('still uploads when the preflight read fails for a reason that says nothing about reachability', async () => {
        harness.setStatResponse({ success: false, error: 'Method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        const hook = await renderTransfers();
        await act(async () => {
            await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual({ ok: true });
        });
        expect(harness.uploads).toHaveLength(1);
    });

    it('finishes the exact staged file without starting a second upload', async () => {
        harness.requireNextUploadFinalizeRecovery();
        const prompt = observeRecoveryPrompt();
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']>;

        await act(async () => {
            pending = hook.getCurrent().startUploads(uploadInput());
            const choose = await prompt;
            choose('retry_finalize');
            await expect(pending).resolves.toEqual({ ok: true });
        });

        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({
            bytes: new TextEncoder().encode('hello'), finalized: true, aborted: false, finalizeAttempts: 2,
        }));
        expect(hook.getCurrent().uploadState).toEqual({ status: 'done', totalFiles: 1, totalBytes: 5 });
    });

    it('blocks a fresh upload while finalize recovery is in flight', async () => {
        harness.requireNextUploadFinalizeRecovery();
        const prompt = observeRecoveryPrompt();
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']>;
        let choose!: Awaited<typeof prompt>;

        await act(async () => {
            pending = hook.getCurrent().startUploads(uploadInput());
            choose = await prompt;
        });
        await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual({
            ok: false, error: 'Uploads already in progress',
        });
        expect(harness.uploads).toHaveLength(1);

        await act(async () => {
            choose('retry_finalize');
            await expect(pending).resolves.toEqual({ ok: true });
        });

        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({ finalized: true, finalizeAttempts: 2 }));
    });

    it.each(['cancel', 'unmount', 'scope change'] as const)('retires unanswered recovery on %s without stranding the next upload', async (retire) => {
        harness.requireNextUploadFinalizeRecovery();
        const prompt = observeRecoveryPrompt();
        const hook = await renderHook(
            (props: Parameters<typeof useWorkspaceFileTransfers>[0]) => useWorkspaceFileTransfers(props),
            { initialProps: { workspaceScope: harness.scope } },
        );
        let settled = false;
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']>;
        await act(async () => {
            pending = hook.getCurrent().startUploads(uploadInput()).then(result => { settled = true; return result; });
            await prompt;
        });
        if (retire === 'unmount') await hook.unmount();
        else if (retire === 'scope change') await hook.rerender({ workspaceScope: { ...harness.scope, rootPath: '/another-repo' } });
        else await act(async () => hook.getCurrent().cancelUploads());
        await vi.waitFor(() => expect(settled).toBe(true));
        await expect(pending).resolves.toEqual({ ok: false, error: 'Upload canceled', canceled: true });
        expect(harness.uploads[0]).toMatchObject({ finalized: false, aborted: false, finalizeAttempts: 1 });
        if (retire !== 'unmount') {
            if (retire === 'scope change') await hook.rerender({ workspaceScope: harness.scope });
            if (originalModalShow) vi.mocked(Modal.show).mockImplementation(originalModalShow);
            await act(async () => {
                await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual({ ok: true });
            });
            expect(hook.getCurrent().uploadState.status).toBe('done');
        }
    });

    it('aborts an in-flight upload on true unmount and keeps late completion inert', async () => {
        const chunk = harness.deferNextUploadChunk();
        const onAfterUploadSuccess = vi.fn();
        const hook = await renderTransfers({ onAfterUploadSuccess });
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startUploads']>;
        await act(async () => {
            pending = hook.getCurrent().startUploads(uploadInput());
            await chunk.entered;
        });

        await hook.unmount();
        await expect(pending).resolves.toEqual({ ok: false, error: 'Upload canceled', canceled: true });
        await act(async () => { chunk.release(); await chunk.settled; });

        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({ bytes: new Uint8Array(), finalized: false, aborted: true }));
        expect(onAfterUploadSuccess).not.toHaveBeenCalled();
    });
});
