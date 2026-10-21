/**
 * The live comparison as the File page knows it: this file's displayed diff, and the other changed
 * files by path only (`pending`), so the review cursor can name and open the next one (rv R2, rvp P2)
 * without the page loading every diff.
 */
export function buildFileChangesLiveFiles(changedPaths: readonly string[], filePath: string, unifiedDiff: string) {
    const files = changedPaths.map(path => path === filePath ? { path, unifiedDiff } : { path, unifiedDiff: '', pending: true });
    return changedPaths.includes(filePath) ? files : [...files, { path: filePath, unifiedDiff }];
}
