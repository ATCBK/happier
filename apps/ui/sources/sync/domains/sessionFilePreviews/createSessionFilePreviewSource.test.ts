import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createBytesPreviewSource, createComposerStagedMediaPreviewSource, createSessionFilePreviewSource } from './createSessionFilePreviewSource';

const nativeFiles = vi.hoisted(() => ({
    current: null as ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock> | null,
}));
vi.mock('expo-file-system', async () => {
    const fixture = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    nativeFiles.current = fixture;
    return fixture.module;
});

// Load the real Sync/transfer graph once, outside behavior timeouts. Only SDK,
// network, credential persistence, filesystem and object-URL boundaries vary.
await loadSyncSingletonForTests();
await import('expo-file-system');

describe('createSessionFilePreviewSource', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | null;
    beforeEach(() => {
        harness = null;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const credentials = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
            if (command.startsWith('desktop_secure_storage_')) return await credentials.invoke(command, args);
            if (command === 'iroh_get_availability') return { available: true };
            if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
            if (command === 'iroh_start_machine_tunnel') return { leaseId: 'preview-desktop-lease', localPort: 48126 };
            if (command === 'iroh_stop_machine_tunnel') return undefined;
            throw new Error(`Unexpected desktop IPC command: ${command}`);
        } });
        nativeFiles.current!.files.clear();
    });
    afterEach(async () => {
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('creates revocable Blob object URLs on web', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'image.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png', maxBytes: 16,
        });
        expect(source.ok, source.ok ? undefined : source.error).toBe(true);
        if (!source.ok || source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');
        expect(source.source).toMatchObject({ uri: 'blob:preview-1', byteLength: 4, mimeType: 'image/png' });
        const blob = createObjectURL.mock.calls[0]![0];
        expect(blob).toBeInstanceOf(Blob);
        if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    });

    it('keeps cold workspace download preparation alive beyond the byte-request deadline', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'hero.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const preparation = harness.deferNextDownloadPreparation();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cold-preview');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'assets/hero.png', mimeType: 'image/png', maxBytes: 16,
        });
        try {
            await preparation.entered;
            const request = harness.requests.find(request => request.url.endsWith('/v1/actions/daemon.filesystem.download'));
            expect(request?.signal).toBeDefined();
            await vi.advanceTimersByTimeAsync(5_001);
            expect(request?.signal?.aborted).toBe(false);
            expect(createObjectURL).not.toHaveBeenCalled();
            preparation.release();
            const result = await pending;
            expect(result).toMatchObject({ ok: true, source: { uri: 'blob:cold-preview', byteLength: 4 } });
            if (result.ok && result.source.kind === 'object-url') result.source.revoke();
        } finally {
            preparation.release();
            await pending;
            vi.useRealTimers();
        }
    });

    it('cancels workspace download preparation when the preview caller retires', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'hero.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const preparation = harness.deferNextDownloadPreparation();
        const controller = new AbortController();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retired-preview');
        const pending = createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'assets/hero.png', mimeType: 'image/png', maxBytes: 16, signal: controller.signal,
        });
        try {
            await preparation.entered;
            const request = harness.requests.find(request => request.url.endsWith('/v1/actions/daemon.filesystem.download'));
            expect(request?.signal?.aborted).toBe(false);
            controller.abort();
            expect(request?.signal?.aborted).toBe(true);
            preparation.release();
            expect(await pending).toMatchObject({ ok: false });
            expect(createObjectURL).not.toHaveBeenCalled();
        } finally {
            preparation.release();
            await pending;
        }
    });

    it('creates a bounded preview from an exact opaque staged-media inspection without a workspace path', async () => {
        harness = await createWorkspaceFileDownloadHarness({
            name: 'incident.png', bytes: new Uint8Array([1, 2, 3, 4]), composerInspection: { id: 'stage_42' },
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:composer-stage-preview');
        if (!harness.composerHandle) throw new Error('Expected Composer stage fixture');
        const source = await createComposerStagedMediaPreviewSource({ handle: harness.composerHandle, maxBytes: 16 });
        expect(source).toMatchObject({ ok: true, source: {
            kind: 'object-url', uri: 'blob:composer-stage-preview', byteLength: 4, mimeType: 'image/png',
        } });
        const preparation = harness.rpcRequests.find(request => request.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        expect(preparation?.payload).toEqual({ t: 'composer_media_stage_inspect_v1', handle: harness.composerHandle, offset: 0, maxBytes: 4 });
        expect(harness.rpcRequests.some(request => request.method === 'daemon.filesystem.download')).toBe(false);
        const blob = createObjectURL.mock.calls[0]![0];
        if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        if (source.ok && source.source.kind === 'object-url') source.source.revoke();
    });

    it('rejects an incomplete staged-media range before it can create a preview source', async () => {
        harness = await createWorkspaceFileDownloadHarness({
            name: 'incident.png', bytes: new Uint8Array([1, 2]), composerInspection: { id: 'stage_partial', sizeBytes: 4 },
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-exist');
        if (!harness.composerHandle) throw new Error('Expected Composer stage fixture');
        const source = await createComposerStagedMediaPreviewSource({ handle: harness.composerHandle, maxBytes: 16 });
        expect(source).toEqual({ ok: false, error: 'Composer media inspection returned an invalid range' });
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('does not create an object URL when the preview request is cancelled after transfer settlement', async () => {
        const controller = new AbortController();
        harness = await createWorkspaceFileDownloadHarness({
            name: 'image.png', bytes: new Uint8Array([1, 2]), onCompleted: () => controller.abort(),
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cancelled-preview');
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png',
            maxBytes: 16, signal: controller.signal,
        });
        expect(harness.requests.some(request => request.url.endsWith('/complete'))).toBe(true);
        expect(source.ok).toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('creates revocable Blob object URLs for supported video evidence references on web', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'recording.webm', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording-preview-1');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
            mimeType: 'video/webm', maxBytes: 16,
        });
        expect(source).toMatchObject({ ok: true, source: {
            kind: 'object-url', uri: 'blob:recording-preview-1', byteLength: 8, mimeType: 'video/webm',
        } });
        if (!source.ok || source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');
        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:recording-preview-1');
    });

    it('writes native previews through the shared cache file sink and deletes them on cleanup', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'image.png', bytes: new Uint8Array([1, 2, 3]) });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png', maxBytes: 16,
        });
        expect(source.ok, source.ok ? undefined : source.error).toBe(true);
        if (!source.ok || source.source.kind !== 'cache-file') throw new Error('Expected cache-file preview source');
        expect(source.source).toMatchObject({ byteLength: 3, mimeType: 'image/png' });
        expect(source.source.uri).toMatch(/^file:\/\/\/cache\/happier-session-file-previews\/[^/]+-image\.png$/);
        expect(nativeFiles.current!.files.get(source.source.uri)).toEqual([1, 2, 3]);
        expect(nativeFiles.current!.close).toHaveBeenCalledWith(source.source.uri);
        await source.source.delete();
        expect(nativeFiles.current!.deleteFile).toHaveBeenCalledWith(source.source.uri);
        expect(nativeFiles.current!.files.size).toBe(0);
    });

    it.each([
        ['icon.svg', 'image/svg+xml'], ['document.pdf', 'application/pdf'], ['voice.mp3', 'audio/mpeg'],
    ])('admits %s through the shared file classifier', async (filePath, mimeType) => {
        harness = await createWorkspaceFileDownloadHarness({ name: filePath, bytes: new Uint8Array([1, 2, 3]) });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath, mimeType, maxBytes: 16,
        });
        expect(source).toMatchObject({ ok: true, source: { mimeType, byteLength: 3 } });
        if (source.ok && source.source.kind === 'object-url') source.source.revoke();
    });

    it('rejects non-previewable files before reading bytes', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'archive.zip' });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'archive.zip', mimeType: 'application/zip', maxBytes: 16,
        });
        expect(source).toEqual({ ok: false, error: 'Unsupported preview type' });
        expect(harness.rpcRequests).toEqual([]);
    });

    it('materializes bytes through the shared budget and destination', async () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bytes');
        const bytes = new Uint8Array([1, 2, 3]);
        expect(await createBytesPreviewSource({ bytes, fileName: 'icon.svg', mimeType: 'image/svg+xml', maxBytes: 2 }))
            .toEqual({ ok: false, error: 'File exceeds the preview size limit' });
        expect(await createBytesPreviewSource({ bytes, fileName: 'icon.svg', mimeType: 'image/svg+xml', maxBytes: 3 }))
            .toMatchObject({ ok: true, source: { uri: 'blob:bytes', byteLength: 3, mimeType: 'image/svg+xml' } });
    });

    it('deletes a native bytes destination cancelled while writing', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const controller = new AbortController();
        nativeFiles.current!.writes.mockImplementationOnce(() => controller.abort());
        const result = await createBytesPreviewSource({
            bytes: new Uint8Array([1, 2, 3]), fileName: 'cancelled.svg', mimeType: 'image/svg+xml', maxBytes: 3,
            signal: controller.signal,
        });
        expect(result).toEqual({ ok: false, error: 'Preview request cancelled' });
        expect(nativeFiles.current!.files.size).toBe(0);
    });

    it('materializes an Android MP4 through the encrypted prepared workspace carrier without an image/text limit', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '2');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
        const result = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null,
        });
        expect(result.ok, result.ok ? undefined : result.error).toBe(true);
        expect(result).toMatchObject({ ok: true, source: { kind: 'cache-file', mimeType: 'video/mp4', byteLength: 3 } });
        if (!result.ok || result.source.kind !== 'cache-file') throw new Error('Expected video cache source');
        expect(nativeFiles.current!.files.get(result.source.uri)).toEqual([1, 2, 3]);
        expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(true);
        await result.source.delete();
        expect(nativeFiles.current!.files.size).toBe(0);
    });
});
