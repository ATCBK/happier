import Fuse from 'fuse.js';
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';

export function normalizeFileSearchText(value: string): string {
    return value.toLowerCase().replace(/\\/g, '/').replace(/[-_ ]+/g, ' ');
}

function fileSearchRelevance(file: FileSearchItem, query: string): number {
    const needle = normalizeFileSearchText(query.trim()).replace(/\/$/, '');
    const name = normalizeFileSearchText(file.fileName).replace(/\/$/, '');
    const path = normalizeFileSearchText(file.fullPath).replace(/\/$/, '');
    if (path === needle || name === needle) return 0;
    if (!needle.includes('/') && !needle.includes('.') && file.fileType === 'file') {
        const extension = name.lastIndexOf('.');
        if (extension > 0 && name.slice(0, extension) === needle) return 1;
    }
    if (!needle.includes('/') && name.startsWith(`${needle}.`)) return 2;
    if ((needle.includes('/') ? path : name).startsWith(needle)) return 3;
    const nameMatch = name.indexOf(needle);
    if (nameMatch >= 0) return nameMatch === 0 || /[/. ]/.test(name[nameMatch - 1] ?? '') ? 4 : 5;
    const pathMatch = path.indexOf(needle);
    if (pathMatch >= 0) return pathMatch === 0 || /[/. ]/.test(path[pathMatch - 1] ?? '') ? 6 : 7;
    return 8;
}

const FILE_SEARCH_NAME_ORDER = new Intl.Collator('en', { numeric: true });

export function rankFileSearchResults(files: FileSearchItem[], query: string): FileSearchItem[] {
    return files.sort((a, b) => fileSearchRelevance(a, query) - fileSearchRelevance(b, query)
        || FILE_SEARCH_NAME_ORDER.compare(a.fileName, b.fileName)
        || FILE_SEARCH_NAME_ORDER.compare(a.fullPath, b.fullPath));
}

/** Fuse supplies candidates; domain relevance and recency owners retain their respective order. */
export function createWorkspaceFileSearchIndex(files: readonly FileSearchItem[], threshold = 0.3): Fuse<FileSearchItem> {
    return new Fuse([...files], {
        keys: [
            { name: 'fileName', weight: 0.7, getFn: file => normalizeFileSearchText(file.fileName) },
            { name: 'fullPath', weight: 0.3, getFn: file => normalizeFileSearchText(file.fullPath) },
        ],
        includeScore: true, threshold, shouldSort: true, ignoreLocation: true, distance: 100,
    });
}

export function matchWorkspaceFileNames(files: readonly FileSearchItem[], query: string): FileSearchItem[] {
    if (!query.trim()) return [...files];
    return new Fuse([...files], {
        keys: [{ name: 'fileName', getFn: file => normalizeFileSearchText(file.fileName) }],
        threshold: 0.3, ignoreLocation: true,
    }).search(normalizeFileSearchText(query.trim())).map(result => result.item);
}
