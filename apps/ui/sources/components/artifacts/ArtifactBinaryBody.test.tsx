import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { Modal } from '@/modal';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent, openArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { fetchArtifactBlob } from '@/sync/api/artifacts/apiArtifacts';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol';

const nativeBoundary = vi.hoisted(() => ({
    filesystem: null as ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock> | null,
    share: async (_uri: string, _name?: string, _mime?: string | null) => {},
}));
vi.mock('expo-file-system', async () => {
    nativeBoundary.filesystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    return nativeBoundary.filesystem.module;
});
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true,
    shareAsync: async (uri: string) => nativeBoundary.share(uri) }));
vi.mock('expo-modules-core', async importOriginal => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions'
        ? { shareFile: (uri: string, fileName: string, mimeType?: string | null) => nativeBoundary.share(uri, fileName, mimeType) }
        : null,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactBinaryBody } from './ArtifactBinaryBody';

beforeEach(async () => {
    await import('expo-file-system');
    nativeBoundary.filesystem!.files.clear();
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0, filesImagePreviewMaxBytes: 1_000_000 });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function binarySource(mime: string, bytes = new Uint8Array([0, 255, 128])) {
    const reference: ArtifactBlobReferenceV1 = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime,
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    // Only captured HTTP is substituted; the actual API mode/schema and binary opening owners run.
    const request = vi.fn(async () => new Response(JSON.stringify({ blobId: reference.blobId,
        content: { t: 'plain', v: encodeBase64(bytes) } })));
    const readBytes = async (artifactId: string, ref: ArtifactBlobReferenceV1, signal?: AbortSignal) => {
        const stored = await fetchArtifactBlob({ token: 'token' }, artifactId, ref.blobId, 'plain', { request, signal });
        return openArtifactBinaryContent({ reference: ref, content: stored.content, mode: 'plain', encryption: null });
    };
    return { reference, bytes, request, readBytes };
}

function installDownloadDocument() {
    const anchor = { href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() };
    const styles = new Map<string, { id: string; textContent: string }>();
    // This is the browser DOM boundary: downloads and the real spinner's stylesheet
    // insertion share one document, just as they do in the browser.
    vi.stubGlobal('document', {
        getElementById: (id: string) => styles.get(id) ?? null,
        createElement: (tag: string) => tag === 'a' ? anchor : { id: '', textContent: '' },
        head: { appendChild: (style: { id: string; textContent: string }) => styles.set(style.id, style) },
        body: { appendChild: () => {} },
    });
    return anchor;
}

describe('ArtifactBinaryBody', () => {
    it.each(['image/svg+xml', 'application/pdf'])('materializes %s through the shared bytes owner', async mime => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource(mime);
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
            blobs.push(blob);
            return 'blob:artifact-preview';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId={mime} name="preview" {...source} />);
            await vi.waitFor(() => expect(blobs).toHaveLength(1));
            expect(blobs[0]!.type).toBe(mime);
            expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(source.bytes);
            await screen.unmount();
            expect(revoke).toHaveBeenCalledWith('blob:artifact-preview');
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
    it('applies the shared web buffering budget before creating an Artifact preview URI', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES', '2');
        const source = binarySource('image/svg+xml');
        const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="svg-budget" name="icon.svg" {...source} />);
            await flushHookEffects();
            expect(createUrl).not.toHaveBeenCalled();
            expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull();
            expect(JSON.stringify(screen.tree.toJSON())).toContain('files.imagePreviewTooLarge');
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
    it.each([
        ['android', 'success'], ['android', 'failure'], ['ios', 'success'], ['ios', 'failure'],
    ] as const)('preserves PDF download custody through %s sharing %s', async (platform, outcome) => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const source = binarySource('application/pdf');
        const filesystem = nativeBoundary.filesystem!;
        const files = filesystem.files;
        const androidShares: string[] = [];
        const iosShares: string[] = [];
        // Only Expo filesystem/native SDK boundaries are substituted; artifact HTTP/schema,
        // content validation, cache lifetime and the sharing adapters remain real.
        nativeBoundary.share = async (uri, name, mimeType) => {
            if (platform === 'ios') {
                iosShares.push(uri);
                expect(files.get(uri)).toEqual([...source.bytes]);
                if (outcome === 'failure') throw new Error('Share sheet failed');
            } else {
                androidShares.push(uri);
                expect(name).toBe('Quarterly report');
                expect(mimeType).toBe('application/pdf');
                expect(files.get(uri)).toEqual([...source.bytes]);
                if (outcome === 'failure') throw new Error('Share chooser failed');
            }
        };
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="pdf" name="Quarterly report" {...source} />);
            await flushHookEffects();
            expect(source.request).toHaveBeenCalledOnce();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await act(async () => { await vi.waitFor(() => expect(androidShares.length + iosShares.length).toBe(1)); });
            const shared = platform === 'android' ? androidShares : iosShares;
            if (platform === 'android' && outcome === 'success') expect([...files.entries()].filter(([uri]) => uri.includes('/happier-downloads/')).map(([, bytes]) => bytes)).toEqual([[...source.bytes]]);
            expect(shared).toHaveLength(1);
            if (platform === 'android') expect(shared[0]).toMatch(/^file:\/\/\/cache\/happier-downloads\/.*Quarterly report$/);
            if (platform === 'android') expect(iosShares).toEqual([]);
            else expect(androidShares).toEqual([]);
            if (platform === 'android' && outcome === 'success') expect(files.get(shared[0]!)).toEqual([...source.bytes]);
            else expect([...files.keys()].filter(uri => uri.includes('/happier-downloads/'))).toEqual([]);
            expect(screen.findByTestId('artifact:downloadFailed') !== null).toBe(outcome === 'failure');
            await screen.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it('cancels an old selection download and leaves the next file actionable', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const first = binarySource('application/zip');
        const pending = createDeferred<Response>();
        first.request.mockImplementation(() => pending.promise);
        const next = binarySource('text/html');
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:next');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = installDownloadDocument();
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="first" name="first.zip" {...first} />);
            await screen.pressByTestIdAsync('artifact:download');
            await screen.update(<ArtifactBinaryBody artifactId="next" name="next.html" {...next} />);
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            pending.resolve(new Response(JSON.stringify({ blobId: first.reference.blobId, content: { t: 'plain', v: encodeBase64(first.bytes) } })));
            await flushHookEffects();
            expect(anchor.download).toBe('next.html');
            expect(anchor.click).toHaveBeenCalledOnce();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('shows private image bytes and releases the temporary preview on unmount', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image/png');
        const urls: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary preview Blob');
            urls.push(blob); return 'blob:private-image';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('artifact:viewerBody-picture')).not.toBeNull();
            expect(new Uint8Array(await urls[0]!.arrayBuffer())).toEqual(source.bytes);
            // The modal presentation is the boundary; the press opens the one Media stage.
            await screen.pressByTestIdAsync('artifact:viewerBody-open');
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
            await screen.unmount();
            await flushHookEffects();
            expect(Modal.show).toHaveBeenCalledOnce();
            expect(revoke).toHaveBeenCalledWith('blob:private-image');
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it('does not fetch or render HTML until explicit Download, and downloads verified bytes', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('text/html');
        const downloaded: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            if (!(blob instanceof Blob)) throw new Error('Expected binary download Blob');
            downloaded.push(blob); return 'blob:download';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const anchor = installDownloadDocument();
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="html" name="page.html" {...source} />);
            expect(source.request).not.toHaveBeenCalled();
            expect(screen.tree.root.findAllByType('iframe')).toHaveLength(0);
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(anchor.download).toBe('page.html');
            expect(anchor.click).toHaveBeenCalledOnce();
            expect(new Uint8Array(await downloaded[0]!.arrayBuffer())).toEqual(source.bytes);
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });

    it('does not disclose an Account-mode mismatch as a preview or download', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const source = binarySource('image/png');
        source.request.mockImplementation(async () => new Response(JSON.stringify({ blobId: source.reference.blobId,
            content: { t: 'encrypted', c: 'AA==' } })));
        const createUrl = vi.spyOn(URL, 'createObjectURL');
        try {
            const screen = await renderScreen(<ArtifactBinaryBody artifactId="image" name="image.png" {...source} />);
            await flushHookEffects();
            expect(screen.findByTestId('artifact:previewFailed')).not.toBeNull();
            await screen.pressByTestIdAsync('artifact:download');
            await flushHookEffects();
            expect(screen.findByTestId('artifact:downloadFailed')).not.toBeNull();
            expect(createUrl).not.toHaveBeenCalled();
        } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
    });
});
