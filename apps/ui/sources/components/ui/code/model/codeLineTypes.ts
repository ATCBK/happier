export type CodeLineKind = 'header' | 'context' | 'add' | 'remove' | 'file';

export type IntraLineDiffSegment = Readonly<{
    text: string;
    kind: 'context' | 'added' | 'removed';
}>;

export type CodeLine = Readonly<{
    id: string;
    // Index in the original source list used to build these lines.
    // For unified diffs: index into `diff.split('\\n')`.
    // For file views: 0-based file line index.
    sourceIndex: number;
    hunkIndex: number | null;
    kind: CodeLineKind;
    oldLine: number | null;
    newLine: number | null;
    renderPrefixText: string;
    renderCodeText: string;
    /** Source-line metadata from the canonical hunk parser, never a separate code row. */
    noEol?: true;
    renderIntraLineDiffSegments?: readonly IntraLineDiffSegment[] | null;
    renderIsHeaderLine: boolean;
    /** A hunk header drawn as the quiet "N unchanged lines" band (both renderers' separator), not the raw `@@` line. */
    renderIsSeparatorLine?: true;
    selectable: boolean;
}>;
