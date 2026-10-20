/** A unified-diff line without its marker or LF terminator. A trailing CR is content. */
export type HunkLine = Readonly<{ kind: 'context' | 'add' | 'remove'; text: string; noEol?: true }>;
export type Hunk = Readonly<{
  index: number;
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  sectionHeading: string;
  lines: readonly HunkLine[];
  firstChange: number; lastChange: number;
}>;
export type HunkApplyResult = Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; reason: 'moved_on' | 'overlap' | 'invalid_hunk' }>;
/** Coordinates are in the post-edit text; insertText is the text to verify before restoring originalText. */
export type InverseEdit = Readonly<{ startUtf16: number; deleteLength: number; insertText: string; originalText: string }>;

const HUNK_HEADER = /^\s*@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)\r?$/;
const NO_EOL = '\\ No newline at end of file';

export function parseUnifiedDiffHunks(unifiedDiff: string): readonly Hunk[] {
  const hunks: Hunk[] = [];
  let current: ({ -readonly [K in keyof Hunk]: Hunk[K] } & { lines: HunkLine[] }) | undefined;
  let oldCount = 0;
  let newCount = 0;
  for (const line of unifiedDiff.split('\n')) {
    // Indented display headers are accepted only outside a declared body. A real context line
    // whose text starts with @@ must remain content, including its leading space marker.
    const header = !current || line.startsWith('@@ ') || (oldCount >= current.oldLines && newCount >= current.newLines)
      ? HUNK_HEADER.exec(line) : null;
    if (header) {
      current = { index: hunks.length, oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]), newLines: Number(header[4] ?? 1), sectionHeading: (header[5] ?? '').trim(),
        lines: [], firstChange: -1, lastChange: -1 };
      hunks.push(current);
      oldCount = 0;
      newCount = 0;
      continue;
    }
    if (line.startsWith('diff --git ')) { current = undefined; continue; }
    if (!current) continue;
    if (line === NO_EOL || line === `${NO_EOL}\r`) {
      const previous = current.lines.at(-1);
      if (previous) current.lines[current.lines.length - 1] = { ...previous, noEol: true };
      continue;
    }
    const marker = line[0];
    const kind = marker === ' ' ? 'context' : marker === '+' ? 'add' : marker === '-' ? 'remove' : null;
    if (!kind) continue;
    current.lines.push({ kind, text: line.slice(1) });
    if (kind !== 'add') oldCount++;
    if (kind !== 'remove') newCount++;
    if (kind !== 'context') {
      if (current.firstChange < 0) current.firstChange = current.lines.length - 1;
      current.lastChange = current.lines.length - 1;
    }
  }
  return hunks;
}

type TextLine = Readonly<{ text: string; noEol?: true }>;
function textLines(text: string): TextLine[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((line, index) => ({ text: line, ...(!text.endsWith('\n') && index === parts.length - 1 ? { noEol: true as const } : {}) }));
}
function lineText(line: TextLine): string { return line.text + (line.noEol ? '' : '\n'); }
function sideLines(hunk: Hunk, side: 'old' | 'new'): readonly HunkLine[] {
  return hunk.lines.filter((line) => line.kind !== (side === 'old' ? 'add' : 'remove'));
}
function validHunk(hunk: Hunk): boolean {
  if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if ((hunk.oldLines > 0 && hunk.oldStart === 0) || (hunk.newLines > 0 && hunk.newStart === 0)) return false;
  for (const side of ['old', 'new'] as const) {
    const lines = sideLines(hunk, side);
    if (lines.length !== (side === 'old' ? hunk.oldLines : hunk.newLines)) return false;
    if (lines.some((line, index) => line.text.includes('\n') || (line.noEol && index !== lines.length - 1))) return false;
  }
  return true;
}
function transformHunks(text: string, hunks: readonly Hunk[], reverse: boolean): HunkApplyResult {
  const original = textLines(text);
  const sourceSide = reverse ? 'new' : 'old';
  const targetSide = reverse ? 'old' : 'new';
  const edits: { start: number; source: readonly HunkLine[]; target: readonly HunkLine[] }[] = [];
  for (const hunk of hunks) {
    if (!validHunk(hunk)) return { ok: false, reason: 'invalid_hunk' };
    const source = sideLines(hunk, sourceSide);
    const target = sideLines(hunk, targetSide);
    const declaredStart = reverse ? hunk.newStart : hunk.oldStart;
    const start = source.length ? declaredStart - 1 : declaredStart;
    edits.push({ start, source, target });
  }
  edits.sort((a, b) => a.start - b.start);
  let previousEnd = -1;
  let previousStart = -1;
  for (const edit of edits) {
    if (edit.start < previousEnd || edit.start === previousStart) return { ok: false, reason: 'overlap' };
    previousEnd = edit.start + edit.source.length;
    previousStart = edit.start;
    if (edit.start < 0 || previousEnd > original.length) return { ok: false, reason: 'moved_on' };
    for (let i = 0; i < edit.source.length; i++) {
      const actual = original[edit.start + i];
      const expected = edit.source[i]!;
      if (!actual || actual.text !== expected.text || !!actual.noEol !== !!expected.noEol) return { ok: false, reason: 'moved_on' };
    }
    if (edit.target.some((line) => line.noEol) && previousEnd !== original.length) return { ok: false, reason: 'moved_on' };
    if (edit.source.length === 0 && edit.target.length > 0 && original[edit.start - 1]?.noEol) return { ok: false, reason: 'moved_on' };
  }
  // All coordinates refer to the original text. Collect disjoint spans once instead of passing
  // a whole-file hunk as function arguments (whose count the JS engine limits).
  const result: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    for (; cursor < edit.start; cursor++) result.push(lineText(original[cursor]!));
    for (const line of edit.target) result.push(lineText(line));
    cursor = edit.start + edit.source.length;
  }
  for (; cursor < original.length; cursor++) result.push(lineText(original[cursor]!));
  return { ok: true, text: result.join('') };
}
export function revertHunks(text: string, hunks: readonly Hunk[]): HunkApplyResult { return transformHunks(text, hunks, true); }
export function applyHunks(text: string, hunks: readonly Hunk[]): HunkApplyResult { return transformHunks(text, hunks, false); }
export function formatHunk(hunk: Hunk): string {
  const heading = hunk.sectionHeading ? ` ${hunk.sectionHeading}` : '';
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${heading}\n`
    + hunk.lines.map((line) => `${line.kind === 'context' ? ' ' : line.kind === 'add' ? '+' : '-'}${line.text}\n${line.noEol ? `${NO_EOL}\n` : ''}`).join('');
}
export function describeHunkRange(hunk: Hunk): Readonly<{ startLine: number; endLine: number; side: 'new' | 'old' }> {
  const side = hunk.newLines ? 'new' : 'old';
  const startLine = side === 'new' ? hunk.newStart : hunk.oldStart;
  const count = side === 'new' ? hunk.newLines : hunk.oldLines;
  return { startLine, endLine: startLine + Math.max(0, count - 1), side };
}
export function applyInverseEdits(text: string, edits: readonly InverseEdit[]): HunkApplyResult {
  const sorted = [...edits].sort((a, b) => a.startUtf16 - b.startUtf16);
  let previousEnd = -1;
  let previousStart = -1;
  for (const edit of sorted) {
    if (![edit.startUtf16, edit.deleteLength].every((n) => Number.isSafeInteger(n) && n >= 0)
      || edit.deleteLength !== edit.originalText.length) return { ok: false, reason: 'invalid_hunk' };
    if (edit.startUtf16 < previousEnd || edit.startUtf16 === previousStart) return { ok: false, reason: 'overlap' };
    previousEnd = edit.startUtf16 + edit.insertText.length;
    previousStart = edit.startUtf16;
    if (previousEnd > text.length || text.slice(edit.startUtf16, previousEnd) !== edit.insertText) return { ok: false, reason: 'moved_on' };
  }
  let result = text;
  for (const edit of sorted.reverse()) result = result.slice(0, edit.startUtf16) + edit.originalText + result.slice(edit.startUtf16 + edit.insertText.length);
  return { ok: true, text: result };
}
