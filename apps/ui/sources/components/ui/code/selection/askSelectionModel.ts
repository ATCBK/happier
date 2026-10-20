import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { buildReviewCommentDraftFromCodeLineRange } from '@/components/ui/code/reviewComments/buildReviewCommentDraftFromCodeLine';
import { resolveCodeLineAnchor } from '@/components/ui/code/reviewComments/resolveCodeLineAnchor';
import type { ReviewCommentDraft, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { computeLineContentHash } from '@/utils/text/lineContentHash';

export type AskSelectionRange = Readonly<{ startLine: number; endLine: number; body?: string; text?: string; side?: 'before' | 'after' }>;
export type FilesAskWithoutSessionTarget = Settings['filesAskWithoutSessionTarget'];

/** One quote format for transcript, terminal and file selections sent outside a Session. */
export function buildAskSelectionQuote(input: Readonly<{
    text: string; filePath?: string | null; startLine?: number; endLine?: number;
}>): string {
    let longestFence = 0;
    for (const match of input.text.matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length);
    const fence = '`'.repeat(Math.max(3, longestFence + 1));
    const reference = input.filePath
        ? `${input.filePath}${input.startLine ? `:${input.startLine}${input.endLine && input.endLine !== input.startLine ? `-${input.endLine}` : ''}` : ''}\n\n`
        : '';
    return `${reference}${fence}\n${input.text}\n${fence}`;
}

export function resolveAskSelectionDestination(input: Readonly<{
    sessionId?: string | null;
    target: FilesAskWithoutSessionTarget;
    detachedSupported: boolean;
    sideRun?: boolean;
}>): 'composer' | 'side_run' | 'new_session' {
    if (input.sessionId && !input.sideRun) return 'composer';
    if ((input.sideRun || input.target === 'detached_run') && input.detachedSupported) return 'side_run';
    return 'new_session';
}

/** Build through the incumbent anchor owner; saved bytes determine dirty-editor anchor hashes. */
export function buildAskSelectionDrafts(input: Readonly<{
    filePath: string;
    source: ReviewCommentSource;
    text: string;
    savedText?: string;
    lines?: readonly CodeLine[];
    ranges: readonly AskSelectionRange[];
    existingDrafts?: readonly ReviewCommentDraft[];
}>): readonly ReviewCommentDraft[] {
    // The read-only table omits the final empty line; an editor caret can select it.
    const fileLines = (text: string) => buildCodeLinesFromFile({ text: text === '' || text.endsWith('\n') ? `${text}\n` : text });
    const liveLines = input.lines ?? fileLines(input.text);
    const savedLines = input.source === 'file' && input.savedText !== undefined
        ? fileLines(input.savedText) : liveLines;
    const seen = new Set<string>();
    return input.ranges.flatMap((range) => {
        const start = Math.max(1, Math.min(range.startLine, range.endLine));
        const end = Math.max(start, range.startLine, range.endLine);
        const key = JSON.stringify([input.filePath, start, end]);
        if (seen.has(key)) return [];
        seen.add(key);
        const lineNumber = (line: CodeLine) => input.source === 'diff' && range.side === 'before'
            ? line.oldLine : line.newLine;
        const liveRange = liveLines.filter((line) => {
            const number = lineNumber(line);
            return !line.renderIsHeaderLine && number !== null && number >= start && number <= end;
        });
        if (!liveRange.length) return [];
        let lines = liveLines;
        let rangeLines = liveRange;
        if (input.source === 'file' && savedLines !== liveLines) {
            const first = liveRange[0]!;
            const resolved = resolveCodeLineAnchor({ filePath: input.filePath, source: 'file', lines: savedLines,
                anchor: { kind: 'fileLine', startLine: start, lineHash: computeLineContentHash(first.renderCodeText) } });
            const savedStart = resolved.lines[0]?.newLine ?? start;
            const candidate = savedLines.filter((line) => line.newLine !== null && line.newLine >= savedStart && line.newLine <= savedStart + end - start);
            if (candidate.length === liveRange.length) { lines = savedLines; rangeLines = candidate; }
        }
        const existing = input.existingDrafts?.find((draft) => draft.filePath === input.filePath && draft.anchor.kind === 'range'
            && draft.anchor.startLine === lineNumber(rangeLines[0]!) && draft.anchor.endLine === lineNumber(rangeLines[rangeLines.length - 1]!)
            && draft.anchor.side === (input.source === 'diff' ? range.side ?? 'after' : undefined));
        const draft = buildReviewCommentDraftFromCodeLineRange({ filePath: input.filePath, source: input.source,
            lines, rangeLines, body: range.body ?? existing?.body ?? '', contextRadius: 2, existing });
        return [{ ...draft, includeInPrompt: true, snapshot: { ...draft.snapshot,
            selectedLines: range.text ? range.text.split('\n') : liveRange.map((line) => line.renderCodeText) } }];
    });
}
