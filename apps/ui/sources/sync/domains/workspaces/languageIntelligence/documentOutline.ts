import type { ShikiScopeToken } from '@/components/ui/code/highlighting/shiki/shikiTokenTypes';
import { isCodeIdentifier } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { readCodeLineIdentifiers } from './codeIdentifiers';

export type DocumentOutlineEntry = Readonly<{
    name: string;
    kind: string;
    line: number;
    column: number;
    depth: number;
}>;

export type DocumentOutlineBaselineInput = Readonly<{
    lines: readonly string[];
    language: string;
    isDark: boolean;
    colors?: Record<string, unknown> | null;
}>;

export type DocumentOutlineBaselineResult =
    | Readonly<{ status: 'ok'; symbols: readonly DocumentOutlineEntry[] }>
    | Readonly<{ status: 'unavailable'; reason: 'grammar_engine_unavailable' }>;

function declarationKind(scopes: readonly string[]): string | null {
    // TextMate also uses entity.name for calls and type references. Declaration
    // context, rather than the name scope alone, keeps those out of the outline.
    if (scopes.some(scope => /^meta\.(?:function[.-]call|macro|attribute|parameters)\b/.test(scope))) return null;
    if (scopes.some(scope => /^meta\.definition\.property\b/.test(scope))) return 'property';
    if (scopes.some(scope => /^meta\.(?:type\.annotation|type\.parameters|return\.type)\b/.test(scope))) return null;
    const namedType = scopes.find(scope => /^entity\.name\.type\.(?:class|struct|interface|enum|alias)\b/.test(scope));
    if (namedType) return namedType.split('.')[3] === 'alias' ? 'type' : namedType.split('.')[3]!;
    if (scopes.some(scope => /^entity\.name\.(?:class|interface|enum|namespace)\b/.test(scope))) {
        return scopes.find(scope => /^entity\.name\.(?:class|interface|enum|namespace)\b/.test(scope))!.split('.')[2]!;
    }
    if (scopes.some(scope => /^entity\.name\.function\b/.test(scope))) return 'function';
    if (scopes.some(scope => /^meta\.definition\.variable\b/.test(scope)) && scopes.some(scope => /^variable\.other\.constant\b/.test(scope))) return 'constant';
    return null;
}

export function buildDocumentOutline(input: Readonly<{
    lines: readonly string[];
    tokensByLine: readonly (readonly ShikiScopeToken[])[];
}>): readonly DocumentOutlineEntry[] {
    const entries: DocumentOutlineEntry[] = [];
    const indentation: number[] = [0];
    for (let index = 0; index < input.lines.length; index++) {
        const row = input.tokensByLine[index] ?? [];
        const heading = row.filter(token => token.scopes.some(scope => /^markup\.heading\b/.test(scope))
            && !token.scopes.some(scope => /^punctuation\.definition\.heading\b/.test(scope)));
        if (heading.length > 0) {
            const first = heading.find(token => token.text.trim());
            const name = heading.map(token => token.text).join('').trim();
            if (first && name) {
                const headingLevel = first.scopes.map(scope => /^heading\.(\d+)\b/.exec(scope)?.[1]).find(Boolean);
                entries.push({ name, kind: 'heading', line: index + 1, column: first.column, depth: headingLevel ? Number(headingLevel) - 1 : 0 });
            }
            continue;
        }
        const identifiers = readCodeLineIdentifiers(input.lines[index]!, null);
        let previous: ShikiScopeToken | undefined;
        for (const token of row) {
            if (!token.text.trim()) continue;
            const prior = previous;
            previous = token;
            if (!isCodeIdentifier(token.text)) continue;
            const kind = declarationKind(token.scopes)
                ?? (prior?.scopes.some(scope => /^storage\.type\.function\b/.test(scope))
                    && token.scopes.some(scope => /^meta\.function\b/.test(scope)) ? 'function' : null);
            if (!kind) continue;
            const identifier = identifiers.find(name => name.startCharacter === token.column);
            const name = identifier?.symbol.startsWith(token.text) ? identifier.symbol : token.text;
            const indent = /^\s*/.exec(input.lines[index]!)![0].length;
            while (indentation.length > 1 && indent < indentation[indentation.length - 1]!) indentation.pop();
            if (indent > indentation[indentation.length - 1]!) indentation.push(indent);
            entries.push({ name, kind, line: index + 1, column: token.column, depth: indentation.length - 1 });
        }
    }
    return entries;
}
