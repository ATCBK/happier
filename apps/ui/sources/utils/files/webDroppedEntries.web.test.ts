import { describe, expect, it } from 'vitest';
import { readWebDroppedEntries } from './webDroppedEntries.web';

type FakeEntry = Readonly<{
    isFile: boolean; isDirectory: boolean; name: string;
    file?: (resolve: (file: File) => void) => void;
    createReader?: () => Readonly<{ readEntries: (resolve: (entries: FakeEntry[]) => void) => void }>;
}>;

const fileEntry = (name: string): FakeEntry => ({ isFile: true, isDirectory: false, name, file: resolve => resolve(new File(['x'], name)) });
function folderEntry(name: string, children: FakeEntry[]): FakeEntry {
    let delivered = false;
    return { isFile: false, isDirectory: true, name, createReader: () => ({
        readEntries: resolve => { resolve(delivered ? [] : children); delivered = true; },
    }) };
}

describe('dropped folder entries', () => {
    it('reports directory metadata, including an entirely empty root, without changing file consumers', async () => {
        const entries = [folderEntry('empty', []), folderEntry('project', [folderEntry('nested-empty', []), fileEntry('a.txt')])];
        const directories: string[] = [];
        const dataTransfer = { files: [], items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })) } as unknown as DataTransfer;
        const files = await readWebDroppedEntries(dataTransfer, { onDirectory: path => directories.push(path) });
        expect(files.map(entry => entry.relativePath)).toEqual(['project/a.txt']);
        expect(directories).toEqual(['empty', 'project', 'project/nested-empty']);
    });
    it('claims every dropped item before walking the first folder, because the browser empties the list after the drop event', async () => {
        const entries = [folderEntry('upload-dir', [fileEntry('a.txt'), folderEntry('sub', [fileEntry('b.txt')])]), fileEntry('loose.txt')];
        let dispatching = true;
        const dataTransfer = { files: [], items: entries.map(entry => ({
            kind: 'file', webkitGetAsEntry: () => dispatching ? entry : null,
        })) } as unknown as DataTransfer;
        const pending = readWebDroppedEntries(dataTransfer);
        dispatching = false; // The drop handler returned; the browser has now emptied the item list.
        expect((await pending).map(entry => entry.relativePath)).toEqual(['upload-dir/a.txt', 'upload-dir/sub/b.txt', 'loose.txt']);
    });
});
