import { applyHunks, parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import type { CodeLine } from './codeLineTypes';

/** Fill omitted unchanged text from the compared revision, retaining every patch row's identity. */
export function expandUnifiedDiffContext(input: Readonly<{
    unifiedDiff: string;
    baseText: string;
    lines: readonly CodeLine[];
}>): readonly CodeLine[] | null {
    // A stale working/index revision must never lend unrelated text to a captured patch.
    const hunks = parseUnifiedDiffHunks(input.unifiedDiff);
    if (!applyHunks(input.baseText, hunks).ok) return null;
    const base = input.baseText.replace(/\r\n/g, '\n').split('\n');
    if (base.at(-1) === '') base.pop();
    if (hunks.length === 0) return input.lines;
    const expanded: CodeLine[] = [];
    let oldLine = 1;
    let newLine = 1;
    const appendUntil = (end: number) => {
        while (oldLine < end) {
            // Omitted rows have no patch offset. Their after-file coordinate keeps
            // existing comment anchors valid; null hunk ownership forbids change actions.
            expanded.push({ id: `context:${oldLine}:${newLine}`, sourceIndex: newLine - 1, hunkIndex: null,
                kind: 'context', oldLine, newLine, renderPrefixText: ' ', renderCodeText: base[oldLine - 1]!,
                renderIsHeaderLine: false, selectable: false });
            oldLine += 1;
            newLine += 1;
        }
    };
    for (const line of input.lines) {
        if (line.kind === 'header' && line.hunkIndex !== null) {
            const hunk = hunks[line.hunkIndex];
            if (hunk) appendUntil(Math.max(1, hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0)));
        }
        expanded.push(line);
        if (line.oldLine !== null) oldLine = line.oldLine + 1;
        if (line.newLine !== null) newLine = line.newLine + 1;
    }
    appendUntil(base.length + 1);
    return expanded;
}
