import type { InverseEdit } from '../diff/hunks.js';
import type { DaemonWorkspaceFileReplaceApplyRequest, DaemonWorkspaceFileReplaceApplyResponse, WorkspaceFileEditSetFile } from './workspaceFiles.js';

type WriterReceipt = Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>['results'][number];
/** Retained UI results may expose their inverse arrays as readonly. */
type ReadonlyWriterReceipt = Readonly<Omit<WriterReceipt, 'edits'> & { edits?: readonly InverseEdit[] }>;

/** A command can write a path repeatedly: Undo consumes each receipt in reverse order. */
export function buildWorkspaceFileRestoreOperation(results: readonly ReadonlyWriterReceipt[]): Extract<DaemonWorkspaceFileReplaceApplyRequest['operation'], { kind: 'restore' }> {
  return { kind: 'restore', files: [...results].reverse().flatMap(result =>
    result.status === 'replaced' && result.hash && result.edits && (result.edits.length > 0 || result.renameTo)
      ? [{ path: result.renameTo ?? result.path, expectedHash: result.hash, edits: [...result.edits],
        ...(result.renameTo ? { renameTo: result.path } : {}) }] : []) };
}

/** A text position outside its document; shared by the Machine's semantic writer and client previews. */
export class WorkspaceTextPositionError extends Error {
  constructor(readonly code: 'invalid_position' | 'symbol_not_found', readonly candidates?: readonly string[]) { super(code); this.name = 'LspDocumentTextError'; }
}

export function workspaceTextLineBounds(text: string, line: number): Readonly<{ start: number; end: number }> {
  if (!Number.isInteger(line) || line < 0) throw new WorkspaceTextPositionError('invalid_position');
  const breaks = /\r\n|\r|\n/gu;
  let start = 0;
  for (let currentLine = 0; ; currentLine++) {
    const nextBreak = breaks.exec(text);
    if (currentLine === line) return { start, end: nextBreak?.index ?? text.length };
    if (!nextBreak) throw new WorkspaceTextPositionError('invalid_position');
    start = nextBreak.index + nextBreak[0].length;
  }
}

export function workspaceTextPositionToOffset(text: string, position: Readonly<{ line: number; character: number }>): number {
  const { start, end } = workspaceTextLineBounds(text, position.line);
  if (!Number.isInteger(position.character) || position.character < 0 || position.character > end - start) {
    throw new WorkspaceTextPositionError('invalid_position');
  }
  return start + position.character;
}

/**
 * The one edit-set text transform: the Machine's guarded writer applies it and clients preview it.
 * Every range addresses the original text; inverse coordinates address the result.
 */
export function applyWorkspaceFileTextEdits(text: string, edits: WorkspaceFileEditSetFile['edits']): Readonly<{ text: string; edits: InverseEdit[] }> {
  const spans = edits.map(edit => ({ start: workspaceTextPositionToOffset(text, edit.range.start), end: workspaceTextPositionToOffset(text, edit.range.end), text: edit.text }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const inverse: InverseEdit[] = [];
  const parts: string[] = [];
  let cursor = 0, delta = 0;
  for (const span of spans) {
    if (span.end < span.start) throw new WorkspaceTextPositionError('invalid_position');
    if (span.start < cursor) throw Object.assign(new Error('Overlapping semantic edits'), { code: 'overlapping_edits' });
    // Encoding must preserve the reviewed text exactly, including Unicode.
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(span.text)) !== span.text)
      throw new WorkspaceTextPositionError('invalid_position');
    const originalText = text.slice(span.start, span.end);
    parts.push(text.slice(cursor, span.start), span.text);
    const startUtf16 = span.start + delta;
    const previous = inverse.at(-1);
    if (previous && previous.startUtf16 + previous.insertText.length === startUtf16) {
      inverse[inverse.length - 1] = { ...previous, deleteLength: previous.deleteLength + originalText.length,
        originalText: previous.originalText + originalText, insertText: previous.insertText + span.text };
    } else inverse.push({ startUtf16, deleteLength: originalText.length, originalText, insertText: span.text });
    delta += span.text.length - originalText.length;
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  const result = parts.join('');
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(result)) !== result)
    throw new WorkspaceTextPositionError('invalid_position');
  return { text: result, edits: inverse };
}

export type ReplaceMatcher = Readonly<{ query: string; replacement: string; matchCase: boolean; regex: boolean }>;
export type ReplaceMatchPosition = Readonly<{ line: number; column16: number }>;
export type ReplaceMatch = ReplaceMatchPosition & Readonly<{
  length16: number; text: string; replacedText: string; before: string[]; after: string[];
}>;
export type FileReplacement =
  | Readonly<{ kind: 'ok'; matches: ReplaceMatch[]; edits: InverseEdit[]; newBytes: Uint8Array }>
  | Readonly<{ kind: 'skip'; reason: 'not_text' | 'binary' | 'utf16' }>;

/** Shared text admission for replacement and inverse restore. The BOM is text. */
export function decodeReplaceFileText(bytes: Uint8Array):
  | Readonly<{ kind: 'ok'; text: string }>
  | Extract<FileReplacement, { kind: 'skip' }> {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { kind: 'skip', reason: 'utf16' };
  }
  if (bytes.includes(0)) return { kind: 'skip', reason: 'binary' };
  try {
    return { kind: 'ok', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { kind: 'skip', reason: 'not_text' };
  }
}

export function computeFileReplacement(
  bytes: Uint8Array,
  matcher: ReplaceMatcher,
  excludedMatches: readonly ReplaceMatchPosition[] = [],
): FileReplacement {
  if (!matcher.query || /[\r\n]/u.test(matcher.query) || /[\r\n\0]/u.test(matcher.replacement)) {
    throw new SyntaxError('Replacement requires a nonempty single-line query and single-line replacement');
  }
  // A non-scalar surrogate would be silently replaced by TextEncoder, making
  // the preview and inverse insertText differ from the bytes actually written.
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(matcher.replacement)) !== matcher.replacement) {
    throw new SyntaxError('Replacement must be valid Unicode text');
  }
  const pattern = matcher.regex ? matcher.query : matcher.query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const caseFlag = matcher.matchCase ? '' : 'i';
  const expression = new RegExp(pattern, `gum${caseFlag}`);
  // Sticky replacement preserves native JS capture, named-capture and context
  // expansion at the exact match (including lookaround), without rematching a
  // detached substring whose surrounding context would have been lost.
  const replacementExpression = matcher.regex ? new RegExp(pattern, `umy${caseFlag}`) : null;
  const decoded = decodeReplaceFileText(bytes);
  if (decoded.kind === 'skip') return decoded;
  const { text } = decoded;
  const excluded = new Set(excludedMatches.map(({ line, column16 }) => `${line}:${column16}`));
  // File/search anchors count LF-delimited lines. Preserve CRLF terminators,
  // and keep a bare CR in its existing line so columns share that owner.
  const pieces = text.split(/(\r\n|\n)/u);
  const lines = pieces.filter((_piece, index) => index % 2 === 0);
  const matches: ReplaceMatch[] = [];
  const edits: InverseEdit[] = [];
  const output: string[] = [];
  let originalOffset = 0;
  let delta = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const bomLength = lineIndex === 0 && line.startsWith('\uFEFF') ? 1 : 0;
    const content = line.slice(bomLength);
    const fragments: string[] = [line.slice(0, bomLength)];
    const lineMatches: ReplaceMatch[] = [];
    let cursor = 0;
    for (const match of content.matchAll(expression)) {
      const column16 = bomLength + match.index + 1;
      if (excluded.has(`${lineIndex + 1}:${column16}`)) continue;
      let insertText = matcher.replacement;
      if (replacementExpression) {
        replacementExpression.lastIndex = match.index;
        const replacedLine = content.replace(replacementExpression, matcher.replacement);
        insertText = replacedLine.slice(match.index, replacedLine.length - (content.length - match.index - match[0].length));
      }
      fragments.push(content.slice(cursor, match.index), insertText);
      const startUtf16 = originalOffset + bomLength + match.index + delta;
      const previous = edits.at(-1);
      // Adjacent removals can share a post-coordinate. Coalesce them so the
      // canonical inverse owner receives one unambiguous, nonoverlapping edit.
      if (previous && previous.startUtf16 + previous.insertText.length === startUtf16) {
        edits[edits.length - 1] = { ...previous, deleteLength: previous.deleteLength + match[0].length,
          insertText: previous.insertText + insertText, originalText: previous.originalText + match[0] };
      } else {
        edits.push({ startUtf16, deleteLength: match[0].length, insertText, originalText: match[0] });
      }
      delta += insertText.length - match[0].length;
      cursor = match.index + match[0].length;
      lineMatches.push({ line: lineIndex + 1, column16, length16: match[0].length, text: line,
        replacedText: '', before: lines.slice(Math.max(0, lineIndex - 2), lineIndex),
        after: lines.slice(lineIndex + 1, lineIndex + 3) });
    }
    fragments.push(content.slice(cursor));
    const replacedText = fragments.join('');
    for (const match of lineMatches) matches.push({ ...match, replacedText });
    const ending = pieces[lineIndex * 2 + 1] ?? '';
    output.push(replacedText, ending);
    originalOffset += line.length + ending.length;
  }
  return { kind: 'ok', matches, edits, newBytes: matches.length ? new TextEncoder().encode(output.join('')) : bytes };
}
