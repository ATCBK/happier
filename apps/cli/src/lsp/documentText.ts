import { CODE_IDENTIFIER_PATTERN, isCodeIdentifier } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import {
    applyWorkspaceFileTextEdits, WorkspaceTextPositionError as LspDocumentTextError,
    workspaceTextLineBounds as lineBounds, workspaceTextPositionToOffset as positionToOffset,
} from '@happier-dev/protocol/machines/workspaceFilesReplace';

// The edit-set transform and its position errors live with the guarded writer's shared protocol owner.
export { applyWorkspaceFileTextEdits, LspDocumentTextError, positionToOffset };

export type LspPosition = Readonly<{ line: number; character: number }>;
export type LspTextEdit = Readonly<{ startLine: number; startCharacter: number; endLine: number; endCharacter: number; text: string }>;
export function readDocumentLine(text: string, line: number): string {
    const { start, end } = lineBounds(text, line);
    return text.slice(start, end);
}

export function applyDocumentTextEdit(text: string, edit: LspTextEdit): string {
    const start = positionToOffset(text, { line: edit.startLine, character: edit.startCharacter });
    const end = positionToOffset(text, { line: edit.endLine, character: edit.endCharacter });
    if (end < start) throw new LspDocumentTextError('invalid_position');
    return text.slice(0, start) + edit.text + text.slice(end);
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
