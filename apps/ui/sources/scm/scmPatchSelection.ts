import { parseUnifiedDiffHunks, type Hunk } from '@happier-dev/protocol/diff/hunks';

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

type SelectionLine = {
    text: string;
    kind: 'context' | 'add' | 'delete' | 'marker';
    oldRef: number | null;
    newRef: number | null;
};

type EmittedHunkLine = {
    text: string;
    oldRef: number | null;
    newRef: number | null;
    carriesChange: boolean;
};

type PatchSelectionMode = 'stage' | 'unstage';

type SelectedDiffLineKey = `${'additions' | 'deletions'}:${number}`;

export function buildSelectedDiffLineKey(side: 'additions' | 'deletions', lineNumber: number): SelectedDiffLineKey | null {
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null;
    return `${side}:${Math.floor(lineNumber)}` as SelectedDiffLineKey;
}

export function extractSelectedDiffLineKeysFromPatch(unifiedDiff: string): Set<string> {
    const selectedLineKeys = new Set<string>();
    if (!unifiedDiff) return selectedLineKeys;

    for (const hunk of parseUnifiedDiffHunks(unifiedDiff)) {
        for (const line of selectionLines(hunk)) {
            const key = line.kind === 'add' && line.newRef !== null
                ? buildSelectedDiffLineKey('additions', line.newRef)
                : line.kind === 'delete' && line.oldRef !== null
                    ? buildSelectedDiffLineKey('deletions', line.oldRef) : null;
            if (key) selectedLineKeys.add(key);
        }
    }

    return selectedLineKeys;
}

/** Selection projection only: canonical lines gain their old/new coordinates and patch markers. */
function selectionLines(hunk: Hunk): SelectionLine[] {
    let oldRef = hunk.oldStart;
    let newRef = hunk.newStart;
    return hunk.lines.flatMap((line): SelectionLine[] => {
        const kind = line.kind === 'remove' ? 'delete' : line.kind;
        const projected: SelectionLine[] = [{ kind, oldRef, newRef,
            text: `${kind === 'context' ? ' ' : kind === 'add' ? '+' : '-'}${line.text}` }];
        if (line.kind !== 'add') oldRef += 1;
        if (line.kind !== 'remove') newRef += 1;
        if (line.noEol) projected.push({ kind: 'marker', text: NO_NEWLINE_MARKER, oldRef: null, newRef: null });
        return projected;
    });
}

function emitHunk(
    lines: SelectionLine[],
    selectedLineKeys: Set<string>,
    mode: PatchSelectionMode
): EmittedHunkLine[] | null {
    const emitted: EmittedHunkLine[] = [];
    let hasSelectedChange = false;

    const isSelected = (line: SelectionLine): boolean => {
        if (line.kind === 'add') {
            if (typeof line.newRef !== 'number') return false;
            const key = buildSelectedDiffLineKey('additions', line.newRef);
            return key ? selectedLineKeys.has(key) : false;
        }
        if (line.kind === 'delete') {
            if (typeof line.oldRef !== 'number') return false;
            const key = buildSelectedDiffLineKey('deletions', line.oldRef);
            return key ? selectedLineKeys.has(key) : false;
        }
        return false;
    };

    for (const line of lines) {
        switch (line.kind) {
            case 'context': {
                emitted.push({
                    text: line.text,
                    oldRef: line.oldRef,
                    newRef: line.newRef,
                    carriesChange: false,
                });
                break;
            }
            case 'add': {
                if (isSelected(line)) {
                    hasSelectedChange = true;
                    emitted.push({
                        text: line.text,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: true,
                    });
                } else if (mode === 'unstage') {
                    // Reverse-apply unstage patches must keep unselected staged additions as context.
                    emitted.push({
                        text: ` ${line.text.slice(1)}`,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: false,
                    });
                }
                break;
            }
            case 'delete': {
                if (isSelected(line)) {
                    hasSelectedChange = true;
                    emitted.push({
                        text: line.text,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: true,
                    });
                } else if (mode === 'stage') {
                    // Keep removed lines as context when not selected so patch positions stay stable.
                    emitted.push({
                        text: ` ${line.text.slice(1)}`,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: false,
                    });
                }
                break;
            }
            case 'marker': {
                if (emitted.length > 0) {
                    emitted.push({
                        text: line.text,
                        oldRef: null,
                        newRef: null,
                        carriesChange: emitted[emitted.length - 1]?.carriesChange === true,
                    });
                }
                break;
            }
        }
    }

    if (!hasSelectedChange) {
        return null;
    }

    // Drop markers that don't follow a selected change to avoid noisy hunks.
    return emitted.filter((line, index) => {
        if (line.text !== NO_NEWLINE_MARKER) return true;
        const previous = emitted[index - 1];
        return previous?.carriesChange === true;
    });
}

function computeHunkHeaderLines(emitted: EmittedHunkLine[]): {
    header: string;
    body: string[];
} | null {
    const body = emitted.map((line) => line.text);
    const contentLines = emitted.filter((line) => line.text !== NO_NEWLINE_MARKER);
    if (contentLines.length === 0) return null;

    const first = contentLines[0];
    const oldStart = first?.oldRef ?? 0;
    const newStart = first?.newRef ?? 0;
    const oldCount = contentLines.filter((line) => line.text.startsWith(' ') || line.text.startsWith('-')).length;
    const newCount = contentLines.filter((line) => line.text.startsWith(' ') || line.text.startsWith('+')).length;

    return {
        header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        body,
    };
}

export function buildPatchFromSelectedDiffLines(
    unifiedDiff: string,
    selectedLineKeys: Set<string>,
    options: { mode?: PatchSelectionMode } = {}
): string | null {
    const mode = options.mode ?? 'stage';
    if (!unifiedDiff || selectedLineKeys.size === 0) {
        return null;
    }

    const lines = unifiedDiff.split('\n');
    const hunks = parseUnifiedDiffHunks(unifiedDiff);
    // Locate the raw prelude for patch output; ranges and content come only from the engine.
    const firstHunkIndex = lines.findIndex((line) => line.trimStart().startsWith('@@ '));
    if (!hunks.length || firstHunkIndex < 0) {
        return null;
    }

    const headerLines = lines.slice(0, firstHunkIndex);
    const oldHeader = headerLines.find((line) => line.startsWith('--- ')) ?? '';
    const newHeader = headerLines.find((line) => line.startsWith('+++ ')) ?? '';
    if (!oldHeader || !newHeader) {
        return null;
    }

    let normalizedHeaderLines = [...headerLines];
    const hasDiffHeader = normalizedHeaderLines.some((line) => line.startsWith('diff --git '));
    if (!hasDiffHeader) {
        const oldPath = oldHeader.replace(/^---\s+/, '').replace(/^a\//, '');
        const newPath = newHeader.replace(/^\+\+\+\s+/, '').replace(/^b\//, '');
        normalizedHeaderLines = [`diff --git a/${oldPath} b/${newPath}`, ...normalizedHeaderLines];
    }

    const renderedHunks: string[] = [];
    for (const parsedHunk of hunks) {
        const emitted = emitHunk(selectionLines(parsedHunk), selectedLineKeys, mode);
        if (!emitted) continue;
        const rendered = computeHunkHeaderLines(emitted);
        if (!rendered) continue;

        const headingSuffix = parsedHunk.sectionHeading ? ` ${parsedHunk.sectionHeading}` : '';
        renderedHunks.push(`${rendered.header}${headingSuffix}`);
        renderedHunks.push(...rendered.body);
    }

    if (renderedHunks.length === 0) {
        return null;
    }

    const patchLines = [...normalizedHeaderLines, ...renderedHunks];
    if (patchLines[patchLines.length - 1] !== '') {
        patchLines.push('');
    }
    return patchLines.join('\n');
}
