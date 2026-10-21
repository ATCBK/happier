import type { DiffHunkInfo, DiffViewerProps } from '../diffViewerTypes';
import { formatPatch, structuredPatch } from 'diff';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { formatHunk } from '@happier-dev/protocol/diff/hunks';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

export type DiffHunkTable = Readonly<{
    hunks: readonly DiffHunkInfo[];
    hunksByAfterLineId: ReadonlyMap<string, readonly DiffHunkInfo[]>;
    /** Each unit's first changed line, where a comment on the change lands. */
    firstChangeLineByKey: ReadonlyMap<string, CodeLine>;
}>;

export function buildDiffHunkTable(props: DiffViewerProps): DiffHunkTable {
    const path = props.filePath ?? '';
    const unifiedDiff = props.mode === 'unified' ? props.unifiedDiff : formatPatch(structuredPatch(
        path, path, props.oldText, props.newText, undefined, undefined, { context: props.contextLines ?? 3 },
    ));
    const parsedUnits = buildReviewUnits(path, null, unifiedDiff);
    const units = props.reviewUnits ?? parsedUnits;
    if (props.reviewUnits && (units.length !== parsedUnits.length || units.some((unit, index) => {
        const parsed = parsedUnits[index]!;
        return unit.hunkIndex !== parsed.hunkIndex || unit.runIndex !== parsed.runIndex
            || formatHunk(unit.hunk) !== formatHunk(parsed.hunk);
    }))) throw new Error('Review units do not match displayed diff');
    const lines = props.mode === 'unified'
        ? props.precomputedLines ?? buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true })
        : buildCodeLinesFromTextDiff({ oldText: props.oldText, newText: props.newText, contextLines: props.contextLines ?? 3 });
    const lineIndices = new Map<string, number>();
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.kind !== 'add' && line.kind !== 'remove') continue;
        lineIndices.set(`${line.hunkIndex}:${line.kind}:${line.kind === 'add' ? line.newLine : line.oldLine}`, index);
    }
    const hunks: DiffHunkInfo[] = [];
    const hunksByAfterLineId = new Map<string, DiffHunkInfo[]>();
    const firstChangeLineByKey = new Map<string, CodeLine>();
    for (const unit of units) {
        const hunk = unit.hunk;
        if (hunk.firstChange < 0) continue;
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines.slice(0, hunk.firstChange)) {
            if (line.kind !== 'add') oldLine += 1;
            if (line.kind !== 'remove') newLine += 1;
        }
        // The label names the lines the change lands on: new-side lines, or the removed lines of a pure deletion.
        let added: [number, number] | null = null;
        let removed: [number, number] | null = null;
        {
            let o = hunk.oldStart; let n = hunk.newStart;
            for (const line of hunk.lines) {
                if (line.kind === 'add') added = added ? [added[0], n] : [n, n];
                if (line.kind === 'remove') removed = removed ? [removed[0], o] : [o, o];
                if (line.kind !== 'add') o += 1;
                if (line.kind !== 'remove') n += 1;
            }
        }
        const range = added ?? removed ?? [hunk.newStart, hunk.newStart];
        const firstChange = hunk.lines[hunk.firstChange]!;
        const lineIndex = lineIndices.get(`${unit.hunkIndex}:${firstChange.kind}:${firstChange.kind === 'add' ? newLine : oldLine}`);
        if (lineIndex === undefined) throw new Error('Review unit has no matching diff line');
        const firstLine = lines[lineIndex]!;
        const changeLineIds: string[] = [];
        for (let index = lineIndex; index < lines.length; index += 1) {
            const line = lines[index]!;
            if (line.hunkIndex !== unit.hunkIndex || (line.kind !== 'add' && line.kind !== 'remove')) break;
            changeLineIds.push(line.id);
        }
        const anchor = lines[lineIndex - 1];
        if (!anchor || anchor.hunkIndex !== unit.hunkIndex) throw new Error('Review unit has no preceding diff anchor');
        const info: DiffHunkInfo = {
            index: hunks.length,
            hunkIndex: unit.hunkIndex,
            key: unit.key,
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            sectionHeading: hunk.sectionHeading,
            rangeStart: range[0],
            rangeEnd: range[1],
            rangeSide: added ? 'new' : 'old',
            firstChangeLineId: firstLine.id,
            revealLineId: anchor.renderIsHeaderLine ? firstLine.id : anchor.id,
            changeLineIds,
        };
        hunks.push(info);
        firstChangeLineByKey.set(info.key, firstLine);
        const anchored = hunksByAfterLineId.get(anchor.id);
        if (anchored) anchored.push(info);
        else hunksByAfterLineId.set(anchor.id, [info]);
    }
    return { hunks, hunksByAfterLineId, firstChangeLineByKey };
}
