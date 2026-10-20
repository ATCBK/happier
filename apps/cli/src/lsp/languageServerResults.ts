import { LanguageIntelligenceRangeSchema, type LanguageIntelligenceDiagnostic, type LanguageIntelligenceDocumentSymbol, type LanguageIntelligenceRange, } from '@happier-dev/protocol/machines/languageIntelligence';
export function readLspObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function readLspRange(value: unknown): LanguageIntelligenceRange {
    const parsed = LanguageIntelligenceRangeSchema.safeParse(value);
    if (!parsed.success)
        throw new Error('Invalid language-server range');
    return parsed.data;
}
export function readLspList(value: unknown): unknown[] {
    if (value === null)
        return [];
    if (!Array.isArray(value))
        throw new Error('Invalid language-server list');
    return value;
}
export function normalizeLspDiagnostics(serverId: string, path: string, value: unknown): LanguageIntelligenceDiagnostic[] {
    return readLspList(value).map(item => {
        const diagnostic = readLspObject(item);
        if (!diagnostic || typeof diagnostic.message !== 'string')
            throw new Error('Invalid language-server diagnostic');
        const severity = diagnostic.severity === 2 ? 'warning' : diagnostic.severity === 3 ? 'information' : diagnostic.severity === 4 ? 'hint' : 'error';
        return { serverId, path, range: readLspRange(diagnostic.range), severity, message: diagnostic.message,
            ...(typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number' ? { code: diagnostic.code } : {}),
            ...(typeof diagnostic.source === 'string' ? { source: diagnostic.source } : {}),
        };
    });
}
function fence(value: string, language = ''): string {
    let longest = 2;
    for (const run of value.matchAll(/`+/gu))
        longest = Math.max(longest, run[0].length);
    const delimiter = '`'.repeat(longest + 1);
    return `${delimiter}${/^[\w.+-]*$/u.test(language) ? language : ''}\n${value}\n${delimiter}`;
}
/** LSP MarkedString and MarkupContent become one host-rendered Markdown value. */
export function normalizeLspHover(value: unknown): Readonly<{
    markdown: string;
    range?: LanguageIntelligenceRange;
}> | null {
    if (value === null)
        return null;
    const hover = readLspObject(value);
    if (!hover || !('contents' in hover))
        throw new Error('Invalid language-server hover');
    const render = (content: unknown): string => {
        if (typeof content === 'string')
            return content;
        const object = readLspObject(content);
        if (!object || typeof object.value !== 'string')
            throw new Error('Invalid language-server hover content');
        if (object.kind === 'markdown')
            return object.value;
        return fence(object.value, typeof object.language === 'string' ? object.language : '');
    };
    return { markdown: (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(render).join('\n\n'),
        ...(hover.range === undefined ? {} : { range: readLspRange(hover.range) }),
    };
}
export function normalizeLspDocumentSymbols(serverId: string, value: unknown): LanguageIntelligenceDocumentSymbol[] {
    return readLspList(value).map(item => {
        const symbol = readLspObject(item);
        if (!symbol || typeof symbol.name !== 'string' || !Number.isInteger(symbol.kind) || Number(symbol.kind) < 1)
            throw new Error('Invalid language-server symbol');
        const location = readLspObject(symbol.location);
        const range = readLspRange(symbol.range ?? location?.range);
        return { serverId, name: symbol.name, kind: Number(symbol.kind), range, selectionRange: symbol.selectionRange === undefined ? range : readLspRange(symbol.selectionRange),
            ...(symbol.children === undefined ? {} : { children: normalizeLspDocumentSymbols(serverId, symbol.children) }),
        };
    });
}
