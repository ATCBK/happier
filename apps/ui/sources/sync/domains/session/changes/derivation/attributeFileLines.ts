import type { FileChangeEvidence } from '@happier-dev/protocol/sessions/changes/types';
import { parseUnifiedDiffHunks, type Hunk } from '@happier-dev/protocol/diff/hunks';

export type FileLineAttributionTurn = Readonly<{
    turnId: string;
    label: string;
    /** Position after sorting with compareTurnChangeSetChronology. */
    order: number;
    evidence: FileChangeEvidence | null;
}>;

type WrittenLine = Readonly<{ turnId: string; text: string }>;
type LineEdit = {
    oldStart: number;
    oldCount: number;
    newCount: number;
    additions: { line: number; text: string }[];
};

/** Context is unchanged, even when it is inside a later turn's hunk. */
function lineEdits(hunks: readonly Hunk[]): LineEdit[] {
    const edits: LineEdit[] = [];
    for (const hunk of hunks) {
        let oldLine = hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0);
        let newLine = hunk.newStart + (hunk.newLines === 0 ? 1 : 0);
        let edit: LineEdit | null = null;
        for (const line of hunk.lines) {
            if (line.kind === 'context') {
                if (edit) edits.push(edit);
                edit = null;
                oldLine++;
                newLine++;
                continue;
            }
            edit ??= { oldStart: oldLine, oldCount: 0, newCount: 0, additions: [] };
            if (line.kind === 'remove') {
                edit.oldCount++;
                oldLine++;
            } else {
                edit.newCount++;
                edit.additions.push({ line: newLine, text: line.text });
                newLine++;
            }
        }
        if (edit) edits.push(edit);
    }
    return edits.sort((left, right) => left.oldStart - right.oldStart);
}

function mapWrittenLinesForward(written: ReadonlyMap<number, WrittenLine>, edits: readonly LineEdit[]) {
    const next = new Map<number, WrittenLine>();
    let editIndex = 0;
    let shift = 0;
    for (const [line, owner] of [...written].sort(([left], [right]) => left - right)) {
        while (editIndex < edits.length) {
            const edit = edits[editIndex]!;
            if (edit.oldStart + edit.oldCount > line) break;
            shift += edit.newCount - edit.oldCount;
            editIndex++;
        }
        const containingEdit = edits[editIndex];
        if (containingEdit && containingEdit.oldStart <= line) continue;
        next.set(line + shift, owner);
    }
    return next;
}

export function attributeUncommittedLines(params: Readonly<{
    uncommittedLines: readonly number[];
    currentLines: readonly string[];
    turns: readonly FileLineAttributionTurn[];
}>): Map<number, { turnId: string } | null> {
    let written = new Map<number, WrittenLine>();
    for (const turn of [...params.turns].sort((left, right) => left.order - right.order)) {
        const evidence = turn.evidence;
        if (!evidence || evidence.truncated || evidence.binary || !evidence.unifiedDiff) continue;
        const edits = lineEdits(parseUnifiedDiffHunks(evidence.unifiedDiff));
        written = mapWrittenLinesForward(written, edits);
        for (const edit of edits) {
            for (const addition of edit.additions) {
                written.set(addition.line, { turnId: turn.turnId, text: addition.text });
            }
        }
    }
    return new Map(params.uncommittedLines.map((line) => {
        const owner = written.get(line);
        return [line, owner && params.currentLines[line - 1] === owner.text ? { turnId: owner.turnId } : null];
    }));
}
