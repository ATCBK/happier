import type { InverseEdit } from '../diff/hunks.js';

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
