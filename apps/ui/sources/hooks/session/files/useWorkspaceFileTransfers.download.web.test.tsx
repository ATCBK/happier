import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, renderHook } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { useWorkspaceFileTransfers } = await import('@/hooks/workspaces/transfers/useWorkspaceFileTransfers');

describe('useWorkspaceFileTransfers web download cleanup', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;

    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'report.txt', bytes: new Uint8Array([1, 2, 3, 4]) });
    });

    afterEach(async () => {
        await act(async () => { await harness?.reset(); });
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        browser?.restore();
    });

    async function renderTransfers() {
        return await renderHook(() => useWorkspaceFileTransfers({ workspaceScope: harness.scope }));
    }

    it('streams into OPFS and delays disk-backed URL cleanup until after the download is triggered', async () => {
        const diskFile = new File([new Uint8Array([1, 2, 3, 4])], 'report.txt');
        const write = vi.fn(async (_bytes: Uint8Array) => {});
        const close = vi.fn(async () => {});
        const abort = vi.fn(async () => {});
        const removeEntry = vi.fn(async () => {});
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-download');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const remove = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'remove');
        const appendChild = vi.spyOn(browser.document.body, 'appendChild');
        Object.defineProperty(browser.window.navigator, 'storage', {
            configurable: true,
            value: {
                getDirectory: async () => ({
                    getFileHandle: async () => ({
                        createWritable: async () => ({ write, close, abort }),
                        getFile: async () => diskFile,
                    }),
                    removeEntry,
                }),
            },
        });
        vi.stubGlobal('Blob', class Blob {
            constructor() {
                throw new Error('whole-payload Blob must not be constructed for OPFS downloads');
            }
        });
        vi.useFakeTimers();
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({ ok: true });
        });

        expect(harness.rpcRequests).toContainEqual(expect.objectContaining({
            machineId: harness.scope.machineId,
            method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ input: expect.objectContaining({ rootPath: '/repo', path: '/repo/report.txt', asZip: false }) }),
        }));
        expect(appendChild).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3, 4]));
        expect(close).toHaveBeenCalledTimes(1);
        expect(createObjectURL).toHaveBeenCalledWith(diskFile);
        expect(remove).not.toHaveBeenCalled();
        expect(removeEntry).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

        expect(remove).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
        expect(removeEntry).toHaveBeenCalledTimes(1);
        expect(abort).not.toHaveBeenCalled();
    });

    it('rejects a prepared file above the configured web maximum before publishing any bytes', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '3');
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({
                ok: false, error: 'File exceeds the web download size limit',
            });
        });

        expect(hook.getCurrent().downloadState).toEqual({ status: 'error', error: 'File exceeds the web download size limit' });
        expect(harness.rpcRequests.some(request => request.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK)).toBe(false);
        expect(click).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('rejects a peer that sends more bytes than its prepared metadata without publishing the file', async () => {
        await harness.reset();
        harness = await createWorkspaceFileDownloadHarness({
            name: 'report.txt', bytes: new Uint8Array([1, 2, 3, 4]), advertisedDownloadSizeBytes: 1,
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();

        await act(async () => {
            await expect(hook.getCurrent().startDownload({ path: 'report.txt', asZip: false })).resolves.toEqual({
                ok: false, error: 'Downloaded size exceeded expected size',
            });
        });

        expect(hook.getCurrent().downloadState).toEqual({ status: 'error', error: 'Downloaded size exceeded expected size' });
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });

    it('does not publish a browser download when unmounted while OPFS materializes the completed file', async () => {
        const fileRequested = createDeferred<void>();
        const materializedFile = createDeferred<File>();
        const diskFile = new File([new Uint8Array([1, 2, 3, 4])], 'report.txt');
        const getFile = vi.fn(async () => {
            fileRequested.resolve();
            return await materializedFile.promise;
        });
        const removeEntry = vi.fn(async () => {});
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-download');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const appendChild = vi.spyOn(browser.document.body, 'appendChild');
        Object.defineProperty(browser.window.navigator, 'storage', {
            configurable: true,
            value: {
                getDirectory: async () => ({
                    getFileHandle: async () => ({
                        createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
                        getFile,
                    }),
                    removeEntry,
                }),
            },
        });
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']>;
        await act(async () => {
            pending = hook.getCurrent().startDownload({ path: 'report.txt', asZip: false });
            await fileRequested.promise;
        });
        expect(getFile).toHaveBeenCalledTimes(1);
        expect(harness.rpcRequests.some(request => request.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);

        await hook.unmount();
        await act(async () => {
            materializedFile.resolve(diskFile);
            await expect(pending).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        });

        expect(removeEntry).toHaveBeenCalledTimes(1);
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(appendChild).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });

    it('aborts an in-flight download on true unmount and ignores its late completion', async () => {
        const chunk = harness.deferNextChunk();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const click = vi.spyOn(browser.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const hook = await renderTransfers();
        let pending!: ReturnType<ReturnType<typeof useWorkspaceFileTransfers>['startDownload']>;
        await act(async () => {
            pending = hook.getCurrent().startDownload({ path: 'report.txt', asZip: false });
            await chunk.entered;
        });

        await hook.unmount();
        await expect(pending).resolves.toEqual({ ok: false, error: 'Download canceled', canceled: true });
        await act(async () => { chunk.release(); await chunk.settled; });

        expect(createObjectURL).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
    });
});
