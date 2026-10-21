import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    written: [] as Uint8Array[],
    cleanup: vi.fn<() => Promise<void>>(),
    close: vi.fn<() => Promise<void>>(),
    source: vi.fn<() => Promise<Readonly<{ kind: 'native'; uri: string }>>>(),
    createSink: vi.fn(),
}));

vi.mock('./package/runnerArtifactAcquisitionSink', () => ({
    createRunnerArtifactAcquisitionSink: mocks.createSink,
}));

import { stageRunnerAttachments } from './stageRunnerAttachments';

describe('creator-local Runner attachment staging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.written.length = 0;
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.close.mockResolvedValue(undefined);
        mocks.source.mockResolvedValue({ kind: 'native', uri: 'file:///runner-stage/notes.txt' });
        mocks.createSink.mockResolvedValue({
            writeBytes: async (bytes: Uint8Array) => { mocks.written.push(bytes.slice()); },
            close: mocks.close,
            cleanup: mocks.cleanup,
            source: mocks.source,
            custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' },
        });
    });

    it('streams mutable source bytes into immutable file custody and records the reviewed facts', async () => {
        const sourceBytes = new Uint8Array([1, 2, 3, 4]);
        const staged = await stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: sourceBytes, name: 'notes.txt', mimeType: 'text/plain' },
            status: 'pending',
        }], { maxFileBytes: 1024 });

        sourceBytes[0] = 9;
        expect(staged.reviewedFiles).toEqual([{
            id: 'file-a',
            name: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            sha256: createHash('sha256').update(new Uint8Array([1, 2, 3, 4])).digest('hex'),
        }]);
        expect(staged.stagedFiles[0]?.source).toMatchObject({
            kind: 'native',
            uri: 'file:///runner-stage/notes.txt',
            name: 'notes.txt',
            sizeBytes: 4,
            mimeType: 'text/plain',
        });
        expect(staged.custodyFiles).toEqual([{
            id: 'file-a',
            name: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' },
        }]);
        expect(mocks.createSink).toHaveBeenCalledWith({
            artifactName: 'notes.txt',
            sizeBytes: 4,
        });
        expect(mocks.written).toEqual([new Uint8Array([1, 2, 3, 4])]);
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(mocks.cleanup).not.toHaveBeenCalled();

        await staged.cleanup();
        await staged.cleanup();
        expect(mocks.cleanup).toHaveBeenCalledOnce();
    });

    it('refuses a folder at source admission with the existing typed error before acquiring file custody', async () => {
        await expect(stageRunnerAttachments([{
            id: 'folder-a', status: 'pending',
            source: { kind: 'folder', name: 'project', mimeType: 'inode/directory', entries: [] },
        }], { maxFileBytes: 1024 })).rejects.toMatchObject({
            code: 'runner_attachment_unavailable', reason: 'folder',
        });
        expect(mocks.createSink).not.toHaveBeenCalled();
    });

    it('registers the exact custody handle before writing its first durable byte', async () => {
        const events: string[] = [];
        mocks.createSink.mockResolvedValue({
            writeBytes: async () => { events.push('write'); },
            close: async () => { events.push('close'); },
            cleanup: mocks.cleanup,
            source: mocks.source,
            custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/notes.txt' },
        });

        await stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1]), name: 'notes.txt', mimeType: 'text/plain' },
            status: 'pending',
        }], {
            maxFileBytes: 1024,
            onCustodyAcquired: async () => { events.push('indexed'); },
            onStagedAttachment: async () => { events.push('reviewed'); },
        });

        expect(events).toEqual(['indexed', 'write', 'close', 'reviewed']);
    });

    it('preserves an empty reviewed attachment through file-backed custody', async () => {
        const staged = await stageRunnerAttachments([{
            id: 'empty-file',
            source: { kind: 'memory', bytes: new Uint8Array(), name: 'empty.txt', mimeType: 'text/plain' },
            status: 'pending',
        }], { maxFileBytes: 1024 });

        expect(mocks.createSink).toHaveBeenCalledWith({
            artifactName: 'empty.txt',
            sizeBytes: 0,
        });
        expect(mocks.written).toEqual([]);
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(staged.reviewedFiles).toEqual([{
            id: 'empty-file',
            name: 'empty.txt',
            mimeType: 'text/plain',
            sizeBytes: 0,
            sha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
        }]);
    });

    it('coalesces concurrent cleanup and retries the exact custody after a failure', async () => {
        const staged = await stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1]), name: 'notes.txt' },
            status: 'pending',
        }], { maxFileBytes: 1024 });
        mocks.cleanup.mockRejectedValueOnce(new Error('file busy')).mockResolvedValueOnce(undefined);

        const first = staged.cleanup();
        const concurrent = staged.cleanup();
        expect(concurrent).toBe(first);
        await expect(first).rejects.toThrow('file busy');
        expect(mocks.cleanup).toHaveBeenCalledOnce();

        await expect(staged.cleanup()).resolves.toBeUndefined();
        await expect(staged.cleanup()).resolves.toBeUndefined();
        expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    });

    it('keeps peak staging chunks bounded while hashing and writing the complete source', async () => {
        const sourceBytes = new Uint8Array(2 * 1024 * 1024 + 7);
        sourceBytes.fill(17);
        const staged = await stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: sourceBytes, name: 'large.bin' },
            status: 'pending',
        }], { maxFileBytes: sourceBytes.byteLength });

        expect(mocks.written.map((chunk) => chunk.byteLength)).toEqual([1024 * 1024, 1024 * 1024, 7]);
        expect(staged.reviewedFiles[0]?.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    });

    it('fails before activation when a staged attachment exceeds the reviewed upload boundary', async () => {
        await expect(stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1, 2]), name: 'large.bin' },
            status: 'pending',
        }], { maxFileBytes: 1 })).rejects.toMatchObject({ code: 'runner_attachment_too_large' });
        expect(mocks.createSink).not.toHaveBeenCalled();
    });

    it('stops staging at the next chunk boundary when preparation is canceled and cleans exact custody', async () => {
        const controller = new AbortController();
        const abortReason = new Error('runner_activation_preparation_canceled');
        mocks.createSink.mockResolvedValue({
            writeBytes: async (bytes: Uint8Array) => {
                mocks.written.push(bytes.slice());
                controller.abort(abortReason);
            },
            close: mocks.close,
            cleanup: mocks.cleanup,
            source: mocks.source,
            custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/large.bin' },
        });
        const sourceBytes = new Uint8Array(2 * 1024 * 1024);
        sourceBytes.fill(3);

        await expect(stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: sourceBytes, name: 'large.bin' },
            status: 'pending',
        }], { maxFileBytes: sourceBytes.byteLength }, controller.signal)).rejects.toBe(abortReason);

        expect(mocks.written).toHaveLength(1);
        expect(mocks.close).not.toHaveBeenCalled();
        expect(mocks.cleanup).toHaveBeenCalledOnce();
    });

    it('preserves the canonical cancellation when exact-custody cleanup also fails', async () => {
        const controller = new AbortController();
        const abortReason = new Error('runner_activation_preparation_canceled');
        mocks.cleanup.mockRejectedValueOnce(new Error('runner_attachment_cleanup_failed'));
        mocks.createSink.mockResolvedValue({
            writeBytes: async (bytes: Uint8Array) => {
                mocks.written.push(bytes.slice());
                controller.abort(abortReason);
            },
            close: mocks.close,
            cleanup: mocks.cleanup,
            source: mocks.source,
            custody: { kind: 'native_cache_file', fileUri: 'file:///runner-stage/large.bin' },
        });

        await expect(stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1, 2]), name: 'large.bin' },
            status: 'pending',
        }], { maxFileBytes: 2 }, controller.signal)).rejects.toBe(abortReason);

        expect(mocks.cleanup).toHaveBeenCalledOnce();
    });

    it('never opens creator custody when preparation was already canceled', async () => {
        const controller = new AbortController();
        const abortReason = new Error('runner_activation_preparation_canceled');
        controller.abort(abortReason);

        await expect(stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1]), name: 'notes.txt' },
            status: 'pending',
        }], { maxFileBytes: 1024 }, controller.signal)).rejects.toBe(abortReason);

        expect(mocks.createSink).not.toHaveBeenCalled();
    });

    it('returns typed unavailable and cleans exact custody when file-backed staging is unavailable', async () => {
        mocks.createSink.mockRejectedValue(new Error('runner_artifact_file_custody_unavailable'));

        await expect(stageRunnerAttachments([{
            id: 'file-a',
            source: { kind: 'memory', bytes: new Uint8Array([1]), name: 'notes.txt' },
            status: 'pending',
        }], { maxFileBytes: 1024 })).rejects.toMatchObject({ code: 'runner_attachment_unavailable' });

        expect(mocks.cleanup).not.toHaveBeenCalled();
    });
});
