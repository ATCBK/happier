import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { revertHunks, type Hunk, type HunkApplyResult } from '@happier-dev/protocol/diff/hunks';
import type { ScmChangeOccurrence } from '@happier-dev/protocol';
import type { EditorDecoration } from './codeEditorTypes';

export type EditorChangeMarker = Extract<EditorDecoration, { kind: string }> & Readonly<{ hunk: Hunk }>;
export type EditorChangeMarkerSeed = Readonly<{ key: string; items: readonly EditorChangeMarker[] }>;
export type EditorChangeRevertResult = HunkApplyResult | Readonly<{ ok: false; reason: 'unavailable' }>;

export function buildEditorChangeMarkers(path: string, layer: ScmChangeOccurrence['layer'] | null | undefined, unifiedDiff: string): readonly EditorChangeMarker[] {
    return buildReviewUnits(path, layer, unifiedDiff).map((unit) => {
        const original = unit.hunk;
        // Context is anchoring evidence for disk writes. A tracked editor range already supplies the
        // location, and only the changed lines must match when reverting the person's draft.
        const prefix = original.lines.slice(0, original.firstChange);
        const changed = original.lines.slice(original.firstChange, original.lastChange + 1);
        const oldLines = changed.filter((line) => line.kind !== 'add').length;
        const newLines = changed.filter((line) => line.kind !== 'remove').length;
        const oldOffset = (original.oldLines ? original.oldStart - 1 : original.oldStart) + prefix.filter((line) => line.kind !== 'add').length;
        const newOffset = (original.newLines ? original.newStart - 1 : original.newStart) + prefix.filter((line) => line.kind !== 'remove').length;
        let oldLine = oldOffset;
        let newLine = newOffset;
        const lines = changed.map((line) => {
            const firstOldLine = line.kind !== 'add' && oldLine++ === 0;
            const firstNewLine = line.kind !== 'remove' && newLine++ === 0;
            // File decoding removes only a leading BOM. Review identity remains the raw-byte unit key.
            return (firstOldLine || firstNewLine) && line.text.startsWith('\uFEFF') ? { ...line, text: line.text.slice(1) } : line;
        });
        const hunk: Hunk = { ...original, oldStart: oldOffset + (oldLines ? 1 : 0), newStart: newOffset + (newLines ? 1 : 0), oldLines, newLines,
            lines, firstChange: 0, lastChange: lines.length - 1 };
        const startLine = Math.max(1, hunk.newStart);
        return { id: unit.key, key: unit.key, kind: oldLines === 0 ? 'added' : newLines === 0 ? 'deleted' : 'modified',
            startLine, endLine: startLine + Math.max(0, newLines - 1), removedLines: lines.filter((line) => line.kind === 'remove').map((line) => line.text),
            ...(newLines === 0 ? { anchor: hunk.newStart === 0 ? 'before' as const : 'after' as const } : {}), hunk };
    });
}

export function revertEditorChangeInDraft(draftText: string, marker: EditorChangeMarker): EditorChangeRevertResult {
    if (marker.hunk.newLines > 0 && marker.endLine - marker.startLine + 1 !== marker.hunk.newLines) return { ok: false, reason: 'moved_on' };
    const newStart = marker.hunk.newLines ? marker.startLine : marker.startLine - (marker.hunk.newStart === 0 ? 1 : 0);
    const result = revertHunks(draftText, [{ ...marker.hunk, newStart }]);
    // Encoding-only changes belong to the file editor's encoding owner, never an engine text command.
    return result.ok && result.text === draftText ? { ok: false, reason: 'unavailable' } : result;
}
