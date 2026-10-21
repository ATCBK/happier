import type { CodeLine } from './codeLineTypes';
import type { IntraLineDiffSegment } from './codeLineTypes';
import { diffWordsWithSpace } from 'diff';
import { parseUnifiedDiffHunks, type HunkLine } from '@happier-dev/protocol/diff/hunks';

function isDiffHeaderLine(line: string): boolean {
    const trimmed = line.trimStart();
    return (
        trimmed.startsWith('diff --git ')
        || trimmed.startsWith('index ')
        || trimmed.startsWith('--- ')
        || trimmed.startsWith('+++ ')
    );
}

export function buildCodeLinesFromUnifiedDiff(params: Readonly<{
    unifiedDiff: string;
    hideFilePrelude?: boolean;
    intraLineDiff?: Readonly<{
        enabled: boolean;
        maxLines: number;
        maxLineLength: number;
        maxPairs?: number;
    }>;
}>): CodeLine[] {
    const rawLines = params.unifiedDiff.replace(/\r\n/g, '\n').split('\n');
    // A diff that ends with a newline terminates its last line; it does not start an empty one.
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();

    const hunks = parseUnifiedDiffHunks(params.unifiedDiff);
    // Raw header locations preserve the existing display ids. The engine owns all ranges and body parsing.
    const headerIndexes: number[] = [];
    const content = new Map<number, HunkLine>();
    let sourceIndex = 0;
    for (const hunk of hunks) {
        while (sourceIndex < rawLines.length && !rawLines[sourceIndex]!.trimStart().startsWith('@@ ')) sourceIndex += 1;
        headerIndexes[hunk.index] = sourceIndex++;
        for (const line of hunk.lines) {
            content.set(sourceIndex, line);
            sourceIndex += line.noEol ? 2 : 1;
        }
    }
    const headers = new Map(hunks.map(hunk => [headerIndexes[hunk.index], hunk]));

    const out: CodeLine[] = [];

    const shouldHidePrelude = params.hideFilePrelude !== false;
    const firstHunkIndex = shouldHidePrelude
        ? headerIndexes[0] ?? -1
        : -1;
    const skipPrelude = shouldHidePrelude && firstHunkIndex >= 0;

    const intraLineMaxPairs = typeof params.intraLineDiff?.maxPairs === 'number'
        ? params.intraLineDiff.maxPairs
        : Number.POSITIVE_INFINITY;
    const intraLineEnabled = params.intraLineDiff?.enabled === true
        && rawLines.length <= (params.intraLineDiff?.maxLines ?? 0);
    const intraLineMaxLineLength = params.intraLineDiff?.maxLineLength ?? 0;
    let remainingIntraLinePairs = intraLineEnabled ? intraLineMaxPairs : 0;

    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let hunkIndex: number | null = null;

    const pendingRemovals: Array<{ outIndex: number; text: string }> = [];

    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i] ?? '';
        const normalized = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
        const trimmed = normalized.trimStart();

        if (skipPrelude && i < firstHunkIndex) {
            // Hide the redundant file-level prelude emitted by `git diff` (diff --git/index/---/+++ plus
            // rename metadata) when we know hunks exist and the file is already shown in surrounding UI.
            continue;
        }

        const header = headers.get(i);
        if (header) {
            pendingRemovals.length = 0;
            oldLine = header.oldStart;
            newLine = header.newStart;
            inHunk = true;
            hunkIndex = header.index;
            out.push({
                id: `h:${i}`,
                sourceIndex: i,
                hunkIndex,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk && isDiffHeaderLine(trimmed)) {
            pendingRemovals.length = 0;
            out.push({
                id: `hd:${i}`,
                sourceIndex: i,
                hunkIndex: null,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk) {
            pendingRemovals.length = 0;
            // Unknown prelude content; treat as header-style.
            out.push({
                id: `p:${i}`,
                sourceIndex: i,
                hunkIndex: null,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        const hunkLine = content.get(i);
        // The engine already attached the following marker to this source line.
        // Do not project it again as numbered/selectable code or break a remove/add pair.
        if (!hunkLine && content.get(i - 1)?.noEol) continue;
        const codeText = hunkLine?.text.replace(/\r$/, '') ?? normalized.slice(1);

        if (hunkLine?.kind === 'add') {
            let renderIntraLineDiffSegments: readonly IntraLineDiffSegment[] | null = null;
            if (intraLineEnabled && remainingIntraLinePairs > 0 && pendingRemovals.length > 0) {
                const pending = pendingRemovals.shift()!;
                const removalLine = out[pending.outIndex];
                if (removalLine && !removalLine.renderIsHeaderLine) {
                    const oldText = pending.text;
                    const newText = codeText;
                    const lengthOk = intraLineMaxLineLength <= 0
                        || (oldText.length <= intraLineMaxLineLength && newText.length <= intraLineMaxLineLength);
                    if (lengthOk) {
                        remainingIntraLinePairs -= 1;
                        const parts = diffWordsWithSpace(oldText, newText);
                        const oldSegments: IntraLineDiffSegment[] = [];
                        const newSegments: IntraLineDiffSegment[] = [];

                        for (const part of parts) {
                            const value = part.value ?? '';
                            if (!value) continue;
                            if (part.added) {
                                newSegments.push({ text: value, kind: 'added' });
                            } else if (part.removed) {
                                oldSegments.push({ text: value, kind: 'removed' });
                            } else {
                                oldSegments.push({ text: value, kind: 'context' });
                                newSegments.push({ text: value, kind: 'context' });
                            }
                        }

                        out[pending.outIndex] = {
                            ...removalLine,
                            renderIntraLineDiffSegments: oldSegments,
                        };
                        renderIntraLineDiffSegments = newSegments;
                    }
                }
            } else if (intraLineEnabled && remainingIntraLinePairs <= 0) {
                pendingRemovals.length = 0;
            }

            const line: CodeLine = {
                id: `a:${i}`,
                sourceIndex: i,
                hunkIndex,
                kind: 'add',
                oldLine: null,
                newLine,
                renderPrefixText: '+',
                renderCodeText: codeText,
                ...(hunkLine.noEol ? { noEol: true as const } : {}),
                renderIntraLineDiffSegments,
                renderIsHeaderLine: false,
                selectable: true,
            };
            out.push(line);
            newLine += 1;
            continue;
        }

        if (hunkLine?.kind === 'remove') {
            const line: CodeLine = {
                id: `r:${i}`,
                sourceIndex: i,
                hunkIndex,
                kind: 'remove',
                oldLine,
                newLine: null,
                renderPrefixText: '-',
                renderCodeText: codeText,
                ...(hunkLine.noEol ? { noEol: true as const } : {}),
                renderIntraLineDiffSegments: null,
                renderIsHeaderLine: false,
                selectable: true,
            };
            if (intraLineEnabled && remainingIntraLinePairs > 0 && pendingRemovals.length < intraLineMaxPairs) {
                pendingRemovals.push({ outIndex: out.length, text: codeText });
            }
            out.push(line);
            oldLine += 1;
            continue;
        }

        // Context line (" ") or blank line inside hunk.
        if (hunkLine?.kind === 'context') {
            pendingRemovals.length = 0;
            out.push({
                id: `c:${i}`,
                sourceIndex: i,
                hunkIndex,
                kind: 'context',
                oldLine,
                newLine,
                renderPrefixText: ' ',
                renderCodeText: codeText,
                ...(hunkLine.noEol ? { noEol: true as const } : {}),
                renderIntraLineDiffSegments: null,
                renderIsHeaderLine: false,
                selectable: false,
            });
            oldLine += 1;
            newLine += 1;
            continue;
        }

        // A `\ No newline at end of file` marker annotates the line before it; it does not break a remove/add pair.
        if (!normalized.startsWith('\\')) pendingRemovals.length = 0;
        out.push({
            id: `x:${i}`,
            sourceIndex: i,
            hunkIndex,
            kind: 'context',
            oldLine,
            newLine,
            renderPrefixText: '',
            renderCodeText: normalized,
            renderIntraLineDiffSegments: null,
            renderIsHeaderLine: false,
            selectable: false,
        });
    }

    return out;
}
