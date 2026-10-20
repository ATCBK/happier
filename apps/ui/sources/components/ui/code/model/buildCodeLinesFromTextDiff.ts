import { formatPatch, structuredPatch } from 'diff';

import type { CodeLine } from './codeLineTypes';
import { buildCodeLinesFromUnifiedDiff } from './buildCodeLinesFromUnifiedDiff';

export function buildCodeLinesFromTextDiff(params: {
    oldText: string;
    newText: string;
    contextLines: number;
}): CodeLine[] {
    const patch = structuredPatch('diff', 'diff', params.oldText, params.newText, undefined, undefined, {
        context: params.contextLines,
    });
    const lines = buildCodeLinesFromUnifiedDiff({
        unifiedDiff: formatPatch(patch),
        intraLineDiff: { enabled: true, maxLines: Number.POSITIVE_INFINITY, maxLineLength: 0 },
    });
    const out: CodeLine[] = [];
    let bodyIndex = 0;
    for (const line of lines) {
        if (line.hunkIndex === null) continue;
        if (line.kind === 'header') {
            bodyIndex = 0;
            out.push({ ...line, id: `th:${line.hunkIndex}`, sourceIndex: out.length });
        } else if (line.renderPrefixText) {
            // Text-mode ids count source lines, excluding unified-diff newline marker rows.
            const prefix = line.kind === 'add' ? 'ta' : line.kind === 'remove' ? 'tr' : 'tc';
            out.push({ ...line, id: `${prefix}:${line.hunkIndex}:${bodyIndex++}`, sourceIndex: out.length });
        }
    }

    return out;
}
