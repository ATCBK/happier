import { beforeEach, describe, expect, it, vi } from 'vitest';
import vector from '../../../../../../../packages/release-runtime/tests/fixtures/runnerZipMinisign.json';

const mocks = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios',
    webSink: {
        writeBytes: vi.fn(),
        close: vi.fn(),
        cleanup: vi.fn(),
        getFile: vi.fn(),
    },
    nativeSink: {
        fileUri: 'file:///cache/happier-runner/runner.zip',
        writeBytes: vi.fn(),
        close: vi.fn(),
        cleanup: vi.fn(),
    },
    createWebDownloadFileSink: vi.fn(),
    createNativeCacheFileSink: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return {
        ...await createReactNativeWebMock(),
        Platform: {
            get OS() {
                return mocks.platform;
            },
            select: (spec: Record<string, unknown>) => spec[mocks.platform] ?? spec.default,
        },
    };
});

vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'runner-acquisition-id' }));
vi.mock('@/hooks/workspaces/transfers/webDownloadFileSink', () => ({
    createWebDownloadFileSink: mocks.createWebDownloadFileSink,
}));
vi.mock('@/sync/runtime/files/nativeCacheFileSink', () => ({
    createNativeCacheFileSink: mocks.createNativeCacheFileSink,
}));

import { createRunnerArtifactAcquisitionSink } from './runnerArtifactAcquisitionSink';
import { acquireRunnerArtifact } from './acquireRunnerArtifact';

describe('createRunnerArtifactAcquisitionSink', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platform = 'web';
        mocks.webSink.getFile.mockResolvedValue(new File(['runner'], 'runner.zip'));
        mocks.createWebDownloadFileSink.mockResolvedValue(mocks.webSink);
        mocks.createNativeCacheFileSink.mockResolvedValue({ ok: true, ...mocks.nativeSink });
    });

    it('uses the authenticated artifact byte size as the browser custody boundary', async () => {
        const sink = await createRunnerArtifactAcquisitionSink({ artifactName: 'happier-runner-linux-x64.zip', sizeBytes: 123 });

        expect(mocks.createWebDownloadFileSink).toHaveBeenCalledWith({
            expectedSizeBytes: 123,
            maxBytes: 123,
            requireFileBacked: true,
        });
        expect(await sink.source()).toMatchObject({ kind: 'web', file: expect.any(File) });
        expect(sink.writeBytes).toBe(mocks.webSink.writeBytes);
        expect(sink.close).toBe(mocks.webSink.close);
        expect(sink.cleanup).toBe(mocks.webSink.cleanup);
    });

    it('uses native cache-file custody and exposes the same local source contract', async () => {
        mocks.platform = 'ios';

        const sink = await createRunnerArtifactAcquisitionSink({ artifactName: 'happier-runner-macos-arm64.zip', sizeBytes: 123 });

        expect(mocks.createNativeCacheFileSink).toHaveBeenCalledWith({
            directoryName: 'happier-runner-artifact-runner-acquisition-id',
            fileName: 'happier-runner-macos-arm64.zip',
        });
        expect(await sink.source()).toEqual({ kind: 'native', uri: mocks.nativeSink.fileUri, sizeBytes: 123 });
        expect(sink.writeBytes).toBe(mocks.nativeSink.writeBytes);
        expect(sink.close).toBe(mocks.nativeSink.close);
        expect(sink.cleanup).toBe(mocks.nativeSink.cleanup);
    });

    it('allows a zero-byte file custody sink for a reviewed empty attachment', async () => {
        mocks.platform = 'web';

        await createRunnerArtifactAcquisitionSink({ artifactName: 'empty.txt', sizeBytes: 0 });

        expect(mocks.createWebDownloadFileSink).toHaveBeenCalledWith({
            expectedSizeBytes: 0,
            maxBytes: 0,
            requireFileBacked: true,
        });
    });

    it('fails before acquisition when native file custody is unavailable', async () => {
        mocks.platform = 'ios';
        mocks.createNativeCacheFileSink.mockResolvedValue({ ok: false, error: 'No cache directory available' });

        await expect(createRunnerArtifactAcquisitionSink({ artifactName: 'runner.zip', sizeBytes: 123 }))
            .rejects.toThrow('runner_artifact_file_custody_unavailable');
    });

    it('does not open the default sink when the signed publication lacks exact archive metadata', async () => {
        const base = 'https://releases.example/runner-v0.3.0';
        const artifact = {
            identity: {
                product: 'happier-runner',
                version: '0.3.0',
                target: 'linux-x64',
                sha256: vector.artifactSha256,
            },
            channel: 'stable',
            url: `${base}/${vector.artifactName}`,
            checksumsUrl: `${base}/checksums.txt`,
            checksumsSignatureUrl: `${base}/checksums.txt.minisig`,
            sizeBytes: 3,
            entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 1, mode: 0o755 }],
        } as const;

        await expect(acquireRunnerArtifact({
            artifact,
            minisignPublicKeyFile: vector.publicKeyFile,
            fetchImpl: async (request) => {
                const url = String(request);
                if (url === artifact.checksumsUrl) return new Response(vector.checksumsText);
                if (url === artifact.checksumsSignatureUrl) return new Response(vector.signatureFile);
                return new Response(new Uint8Array([1, 2, 3]));
            },
        })).rejects.toThrow('runner_artifact_identity_mismatch');

        expect(mocks.createWebDownloadFileSink).not.toHaveBeenCalled();
    });
});
