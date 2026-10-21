import { CODE_IDENTIFIER_PATTERN, isCodeIdentifier } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import type { InverseEdit } from '@happier-dev/protocol/diff/hunks';

export type LspPosition = Readonly<{ line: number; character: number }>;
export type LspTextEdit = Readonly<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; text: string }>;
export class LspDocumentTextError extends Error {
    constructor(readonly code: 'invalid_position' | 'symbol_not_found', readonly candidates?: readonly string[]) { super(code); this.name = 'LspDocumentTextError'; }
}

function lineBounds(text: string, line: number): Readonly<{ start: number; end: number }> {
    if (!Number.isInteger(line) || line < 0) throw new LspDocumentTextError('invalid_position');
    const breaks = /\r\n|\r|\n/gu;
    let start = 0;
    for (let currentLine = 0; ; currentLine++) {
        const nextBreak = breaks.exec(text);
        if (currentLine === line) return { start, end: nextBreak?.index ?? text.length };
        if (!nextBreak) throw new LspDocumentTextError('invalid_position');
        start = nextBreak.index + nextBreak[0].length;
    }
}

export function readDocumentLine(text: string, line: number): string {
    const { start, end } = lineBounds(text, line);
    return text.slice(start, end);
}

export function positionToOffset(text: string, position: LspPosition): number {
    const { start, end } = lineBounds(text, position.line);
    if (!Number.isInteger(position.character) || position.character < 0 || position.character > end - start) {
        throw new LspDocumentTextError('invalid_position');
    }
    return start + position.character;
}

export function applyDocumentTextEdit(text: string, edit: LspTextEdit): string {
    const start = positionToOffset(text, { line: edit.startLine, character: edit.startCharacter });
    const end = positionToOffset(text, { line: edit.endLine, character: edit.endCharacter });
    if (end < start) throw new LspDocumentTextError('invalid_position');
    return text.slice(0, start) + edit.text + text.slice(end);
}

/** Every range addresses the original text; inverse coordinates address the result. */
export function applyWorkspaceFileTextEdits(text: string, edits: WorkspaceFileEditSetFile['edits']): Readonly<{ text: string; edits: InverseEdit[] }> {
    const spans = edits.map(edit => ({ start: positionToOffset(text, edit.range.start), end: positionToOffset(text, edit.range.end), text: edit.text }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const inverse: InverseEdit[] = [];
    const parts: string[] = [];
    let cursor = 0, delta = 0;
    for (const span of spans) {
        if (span.end < span.start) throw new LspDocumentTextError('invalid_position');
        if (span.start < cursor) throw Object.assign(new Error('Overlapping semantic edits'), { code: 'overlapping_edits' });
        // Encoding must preserve the reviewed text exactly, including Unicode.
        if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(span.text)) !== span.text)
            throw new LspDocumentTextError('invalid_position');
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
        throw new LspDocumentTextError('invalid_position');
    return { text: result, edits: inverse };
}

export function resolveSymbolColumn(text: string, input: Readonly<{ line: number; symbol: string; occurrence?: number }>): number {
    const line = readDocumentLine(text, input.line);
    const occurrence = input.occurrence ?? 1;
    if (!Number.isInteger(occurrence) || occurrence < 1) throw new LspDocumentTextError('invalid_position');
    const identifiers = [...line.matchAll(new RegExp(CODE_IDENTIFIER_PATTERN, 'gu'))].filter(match => {
        if (match.index === 0) return true;
        // The shared grammar also defines continuation characters: prepending a
        // valid start tests a preceding code point without a second lexer.
        const previousUnit = line.charCodeAt(match.index - 1);
        const previousIndex = match.index - (previousUnit >= 0xdc00 && previousUnit <= 0xdfff ? 2 : 1);
        const previous = line.codePointAt(previousIndex);
        return previous === undefined || !isCodeIdentifier(`a${String.fromCodePoint(previous)}`);
    });
    const candidates = [...new Set(identifiers.map(match => match[0]))];
    if (!isCodeIdentifier(input.symbol)) throw new LspDocumentTextError('symbol_not_found', candidates);
    const exact = identifiers.filter(match => match[0] === input.symbol);
    const folded = new RegExp(`^${input.symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'iu');
    const selected = (exact.length > 0 ? exact : identifiers.filter(match => folded.test(match[0])))[occurrence - 1];
    if (!selected) throw new LspDocumentTextError('symbol_not_found', candidates);
    return selected.index;
}

export function resolveDocumentPosition(text: string, input: LspPosition | Readonly<{ line: number; symbol: string; occurrence?: number }>): LspPosition {
    const character = 'symbol' in input ? resolveSymbolColumn(text, input) : input.character;
    const position = { line: input.line, character };
    positionToOffset(text, position);
    return position;
}
