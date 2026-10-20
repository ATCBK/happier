import { readFile, access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ScmFileReadResponseSchema } from '@happier-dev/protocol/scm';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/protocol/actions/externalActionLimits';
import { deliverScmFileAtRevision } from './deliverScmFileAtRevision';

describe('revision file delivery', () => {
    it('keeps small reads inline and publishes larger allowed reads with the existing disposable file source', async () => {
        const inline = { success: true as const, contentBase64: 'AP+A', sizeBytes: 3, sha256: 'a'.repeat(64) };
        expect(await deliverScmFileAtRevision({ request: { path: 'image.png', selector: { blobId: 'a'.repeat(40) } }, response: inline })).toBe(inline);
        const bytes = Buffer.alloc(18_000_000, 0xff);
        const response = { success: true as const, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') };
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(response)).toBe(false);
        let capturedPath: string | undefined;
        let dispose: (() => Promise<void> | void) | undefined;
        const delivered = await deliverScmFileAtRevision({ request: { path: 'image.png', selector: { blobId: 'a'.repeat(40) }, maxBytes: bytes.length }, response,
            lifecycle: { clearPublishedTransfer: () => false, publishTransferWhenReady: async input => {
                const source = input.payloadSource;
                if (!source || source.kind !== 'file') throw new Error('File-backed publication required');
                capturedPath = source.filePath; dispose = source.dispose;
                expect(await readFile(source.filePath)).toEqual(bytes);
                return { transferId: input.transferId, transferToken: 'token', endpointCandidates: [], expiresAt: Date.now() + 60_000 };
            } } });
        expect(ScmFileReadResponseSchema.parse(delivered)).toMatchObject({ success: true, sizeBytes: bytes.length, sha256: response.sha256,
            prepared: { name: 'image.png', manifestHash: `sha256:${response.sha256}` } });
        expect(delivered).not.toHaveProperty('contentBase64');
        await dispose?.();
        await expect(access(capturedPath!)).rejects.toMatchObject({ code: 'ENOENT' });

        await expect(deliverScmFileAtRevision({ request: { path: 'image.png', selector: { blobId: 'a'.repeat(40) } }, response,
            lifecycle: { clearPublishedTransfer: () => false, publishTransferWhenReady: async input => {
                if (input.payloadSource?.kind !== 'file') throw new Error('File-backed publication required');
                capturedPath = input.payloadSource.filePath;
                throw new Error('Publication failed');
            } } })).rejects.toThrow('Publication failed');
        await expect(access(capturedPath!)).rejects.toMatchObject({ code: 'ENOENT' });

        const cancellation = new AbortController(); let cleared = false;
        await expect(deliverScmFileAtRevision({ request: { path: 'image.png', selector: { blobId: 'a'.repeat(40) } }, response,
            signal: cancellation.signal, lifecycle: { clearPublishedTransfer: () => { cleared = true; return true; },
                publishTransferWhenReady: async input => {
                    if (input.payloadSource?.kind !== 'file') throw new Error('File-backed publication required');
                    capturedPath = input.payloadSource.filePath; cancellation.abort();
                    return { transferId: input.transferId, transferToken: 'token', endpointCandidates: [], expiresAt: Date.now() + 60_000 };
                } } })).rejects.toMatchObject({ name: 'AbortError' });
        expect(cleared).toBe(true);
        await expect(access(capturedPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
