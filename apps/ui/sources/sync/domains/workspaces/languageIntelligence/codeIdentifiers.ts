import { tokenizeSimpleSyntaxLine } from '@/components/ui/code/tokenization/simpleSyntaxTokenizer';
import { CODE_IDENTIFIER_PATTERN } from '@happier-dev/protocol/machines/codeIntelligenceFallback';

const identifierPattern = new RegExp(CODE_IDENTIFIER_PATTERN, 'gu');

export type CodeIdentifier = Readonly<{ symbol: string; startCharacter: number; endCharacter: number }>;
export type CodeIntelligencePosition = Readonly<{ line: number; character: number }>;

export function readCodeLineIdentifiers(line: string, languageId: string | null): readonly CodeIdentifier[] {
    const names: CodeIdentifier[] = [];
    let offset = 0;
    for (const token of tokenizeSimpleSyntaxLine({ line, language: languageId })) {
        if (token.type === 'default') {
            for (const match of token.text.matchAll(identifierPattern)) {
                const startCharacter = offset + match.index;
                names.push({ symbol: match[0], startCharacter, endCharacter: startCharacter + match[0].length });
            }
        }
        offset += token.text.length;
    }
    return names;
}

export function resolveCodeIdentifier(text: string, position: CodeIntelligencePosition, languageId: string | null): CodeIdentifier | null {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) return null;
    const line = text.split(/\r\n|\r|\n/u)[position.line];
    if (line === undefined || position.character > line.length) return null;
    const names = readCodeLineIdentifiers(line, languageId);
    return names.find(name => position.character >= name.startCharacter && position.character < name.endCharacter)
        ?? names.find(name => position.character === name.endCharacter)
        ?? null;
}

