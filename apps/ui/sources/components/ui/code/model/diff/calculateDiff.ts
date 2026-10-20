import { diffLines } from 'diff';

export function getDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const change of diffLines(oldText, newText)) {
        const lineCount = change.value.split('\n').length - (change.value.endsWith('\n') ? 1 : 0);
        if (change.added) additions += lineCount;
        if (change.removed) deletions += lineCount;
    }
    return { additions, deletions };
}
