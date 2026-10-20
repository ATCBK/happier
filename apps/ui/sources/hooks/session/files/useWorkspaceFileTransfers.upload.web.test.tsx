import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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

        expect(hook.getCurrent().uploadState).toEqual({ status: 'error', error: 'Direct import request failed with status 409' });
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

        expect(hook.getCurrent().uploadState).toEqual({ status: 'error', error: 'Upload source reader exploded' });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]).toEqual(expect.objectContaining({ bytes: new Uint8Array(), finalized: false, aborted: true }));
    });

    it('settles an abort that escapes preflight as a quiet cancellation, and any other escape as an error, never a rejection', async () => {
        harness.setStatResponse({ success: true, exists: true });
        for (const [thrown, expected, state] of [
            [new DOMException('signal is aborted without reason', 'AbortError'), { ok: false, error: 'Upload canceled', canceled: true }, { status: 'canceled' }],
            [new Error('Conflict prompt exploded'), { ok: false, error: 'Conflict prompt exploded' }, { status: 'error', error: 'Conflict prompt exploded' }],
        ] as const) {
            const hook = await renderTransfers({ onResolveUploadConflicts: async () => { throw thrown; } });
            await act(async () => {
                await expect(hook.getCurrent().startUploads(uploadInput())).resolves.toEqual(expected);
            });
            expect(hook.getCurrent().uploadState).toEqual(state);
            expect(harness.uploads).toHaveLength(0);
        }
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
