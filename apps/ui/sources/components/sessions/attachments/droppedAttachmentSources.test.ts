import { describe, expect, it } from 'vitest';
import { groupWebDroppedEntries } from './droppedAttachmentSources';

describe('dropped attachment sources', () => {
    it('groups a tree and empty directories into one folder while retaining loose files', () => {
        const file = new File(['a'], 'a.txt');
        const loose = new File(['loose'], 'loose.txt');
        const sources = groupWebDroppedEntries([{ file, relativePath: 'project/nested/a.txt' },
            { file: loose, relativePath: 'loose.txt' }], ['empty', 'project', 'project/nested', 'project/nested/empty']);
        expect(sources).toEqual([
            { kind: 'folder', name: 'empty', mimeType: 'inode/directory', entries: [], directories: [] },
            { kind: 'folder', name: 'project', mimeType: 'inode/directory',
                entries: [{ relativePath: 'nested/a.txt', source: { kind: 'web', file } }], directories: ['nested', 'nested/empty'] },
            { kind: 'web', file: loose },
        ]);
    });
    it('rejects source paths that could escape the destination', () => {
        const file = new File(['a'], 'a.txt');
        expect(groupWebDroppedEntries([{ file, relativePath: '../escape/a.txt' },
            { file, relativePath: '/absolute/a.txt' }], ['../bad', 'C:\\bad'])).toEqual([]);
    });
});
