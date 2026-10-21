import type { AttachmentUploadSource, AttachmentFolderEntry } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { WebDroppedFileEntry } from '@/utils/files/webDroppedEntries';
import { resolveUploadRelativePath } from '@/sync/domains/transfers/uploadRelativePath';

/** The browser reader includes the root name in each relative path. */
export function groupWebDroppedEntries(entries: readonly WebDroppedFileEntry[], directories: readonly string[] = []): readonly AttachmentUploadSource[] {
    const sources: AttachmentUploadSource[] = [];
    const folders = new Map<string, AttachmentFolderEntry[]>();
    const subdirectories = new Map<string, string[]>();
    for (const directory of directories) {
        const path = resolveUploadRelativePath('', directory);
        if (!path) continue;
        const [name, ...parts] = path.split('/');
        if (!folders.has(name!)) {
            const entries: AttachmentFolderEntry[] = [];
            const nested: string[] = [];
            folders.set(name!, entries);
            subdirectories.set(name!, nested);
            sources.push({ kind: 'folder', name: name!, mimeType: 'inode/directory', entries, directories: nested });
        }
        if (parts.length) subdirectories.get(name!)?.push(parts.join('/'));
    }
    for (const entry of entries) {
        const path = resolveUploadRelativePath('', entry.relativePath);
        if (!path) continue;
        const slash = path.indexOf('/');
        if (slash < 0) {
            sources.push({ kind: 'web', file: entry.file });
            continue;
        }
        const name = path.slice(0, slash);
        let folder = folders.get(name);
        if (!folder) {
            folder = [];
            folders.set(name, folder);
            sources.push({ kind: 'folder', name, mimeType: 'inode/directory', entries: folder });
        }
        folder.push({ relativePath: path.slice(slash + 1), source: { kind: 'web', file: entry.file } });
    }
    return sources;
}
