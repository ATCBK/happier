import { describe, expect, it } from 'vitest';
import { prepareAttachmentPayloads } from './prepareAttachmentPayloads';
import { hashBinaryContent } from '@/sync/encryption/binaryContent';

const id = 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86';
describe('shared attachment payload preparation', () => {
    it('retains files, normalized folder paths and empty directories without an upload', async () => {
        const bytes = new Uint8Array([0, 255, 10]);
        const source = { kind: 'memory' as const, name: 'picture.png', mimeType: 'image/png', bytes };
        const folder = { kind: 'folder' as const, name: 'research', mimeType: 'inode/directory' as const,
            entries: [{ relativePath: 'images/cafe\u0301.png', source }], directories: ['empty/cafe\u0301'] };
        const prepared = await prepareAttachmentPayloads({ drafts: [{ id, source: folder }], maxFileBytes: 10 });
        expect(prepared.attachments).toMatchObject([{ kind: 'folder', id, name: 'research', directories: ['empty/cafe\u0301'],
            entries: [{ relativePath: 'images/cafe\u0301.png', file: { mime: 'image/png', sizeBytes: 3, sha256: hashBinaryContent(bytes) } }] }]);
        expect(prepared.sources[0]?.source).toBe(source);
        const retried = await prepareAttachmentPayloads({ drafts: [{ id, source: folder }], maxFileBytes: 10, previous: prepared.attachments });
        expect(retried.attachments).toEqual(prepared.attachments);
        expect(await prepareAttachmentPayloads({ drafts: [{ id, source: { ...folder, entries: [] } }], maxFileBytes: 10 }))
            .toMatchObject({ attachments: [{ kind: 'folder', directories: ['empty/cafe\u0301'], entries: [] }], sources: [] });
        expect(await prepareAttachmentPayloads({ drafts: [{ id, source: { ...source, name: '  cafe\u0301 report.txt  ' } }], maxFileBytes: 10 }))
            .toMatchObject({ attachments: [{ name: '  café report.txt  ' }] });
    });

    it('rejects a changed retained leaf, a size violation and a retired scope', async () => {
        const source = { kind: 'memory' as const, name: 'sample.bin', bytes: new Uint8Array([1, 2]) };
        const input = { drafts: [{ id, source }], maxFileBytes: 2 };
        const original = await prepareAttachmentPayloads(input);
        await expect(prepareAttachmentPayloads({ ...input, drafts: [{ id, source: { ...source, bytes: new Uint8Array([2, 1]) } }], previous: original.attachments }))
            .rejects.toMatchObject({ code: 'attachment_source_changed' });
        await expect(prepareAttachmentPayloads({ ...input, maxFileBytes: 1 })).rejects.toMatchObject({ code: 'attachment_too_large' });
        await expect(prepareAttachmentPayloads({ ...input, isCurrent: () => false })).rejects.toMatchObject({ code: 'canceled' });
    });
});
