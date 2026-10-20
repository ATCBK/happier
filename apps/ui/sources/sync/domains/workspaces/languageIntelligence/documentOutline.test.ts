import { describe, expect, it } from 'vitest';

import { loadDocumentOutlineBaseline } from './loadDocumentOutlineBaseline';
import { selectDocumentOutline, type DocumentOutlineBaselineResult, type DocumentOutlineServerAnswer } from './documentOutline';

const baseline: DocumentOutlineBaselineResult = { status: 'ok', symbols: [
    { name: 'Approximate', kind: 'class', line: 1, column: 0, depth: 0 },
] };
const server: DocumentOutlineServerAnswer = {
    capable: true, state: 'ready', loading: false,
    symbols: [{ serverId: 'language-server', name: 'Accurate', kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
        selectionRange: { start: { line: 2, character: 3 }, end: { line: 2, character: 11 } },
        children: [{ serverId: 'language-server', name: 'read', kind: 6,
            range: { start: { line: 3, character: 0 }, end: { line: 7, character: 1 } },
            selectionRange: { start: { line: 4, character: 8 }, end: { line: 4, character: 12 } } }],
    }],
};

describe('document outline', () => {
    it('prefers nonempty server symbols while loading and flattens selection positions and hierarchy', () => {
        expect(selectDocumentOutline({ baseline, server: { ...server, state: 'starting', loading: true } })).toEqual({
            status: 'ok', symbols: [
                { serverId: 'language-server', name: 'Accurate', kind: 'class', line: 3, column: 3, depth: 0 },
                { serverId: 'language-server', name: 'read', kind: 'method', line: 5, column: 8, depth: 1, container: 'Accurate' },
            ],
        });
    });

    it('keeps authoritative empty answers empty, including when the grammar is unavailable', () => {
        expect(selectDocumentOutline({ baseline, server: { ...server, symbols: [] } })).toEqual({ status: 'ok', symbols: [] });
        expect(selectDocumentOutline({ baseline: { status: 'unavailable', reason: 'grammar_engine_unavailable' }, server })).toMatchObject({
            status: 'ok', symbols: [{ name: 'Accurate' }, { name: 'read' }],
        });
    });

    it('retains the baseline for cold, loading, failed, missing or incapable server answers', () => {
        for (const answer of [
            null, { ...server, state: 'starting' as const, symbols: [] },
            { ...server, loading: true, symbols: [] }, { ...server, state: 'crashed' as const },
            { ...server, state: 'unavailable' as const }, { ...server, capable: false },
        ]) expect(selectDocumentOutline({ baseline, server: answer })).toBe(baseline);
    });

    it('reads the grammar whose includeExplanation projection throws in Shiki 3.22', async () => {
        const { shikiTokenizeScopeLines } = await import('@/components/ui/code/highlighting/shiki/shikiTokenize');
        const lines = ['class Example {}', 'function sample() {}'];
        const rows = await shikiTokenizeScopeLines({ isDark: false, language: 'wolfram', lines });
        expect(rows.map(row => row.map(token => token.text).join(''))).toEqual(lines);
        expect(rows.flat().some(token => token.scopes.includes('symbol.unrecognized.wolfram'))).toBe(true);
    });

    it('retains Unicode identifier marks and Other_ID_Start characters from grammar tokens', async () => {
        const result = await loadDocumentOutlineBaseline({ isDark: false, language: 'typescript', lines: [
            'export function ℘() {}', 'export function café() {}',
        ] });
        if (result.status !== 'ok') throw new Error('Expected grammar engine');
        expect(result.symbols.map(entry => entry.name)).toEqual(['℘', 'café']);
    });

    it('does not turn an inline parameter type into a class member', async () => {
        const result = await loadDocumentOutlineBaseline({ isDark: false, language: 'typescript', lines: [
            'class Box {', '    constructor(options: Readonly<{ value: number }>) {}', '}',
        ] });
        if (result.status !== 'ok') throw new Error('Expected grammar engine');
        expect(result.symbols.map(entry => entry.name)).toEqual(['Box']);
    });

    it('keeps members of a generic-wrapped type alias without listing JSX references', async () => {
        const result = await loadDocumentOutlineBaseline({ isDark: false, language: 'tsx', lines: [
            'export type Props = Readonly<{',
            '    label: string;',
            '}>;',
            'export const Card = (props: Props) => <p>{props.label}</p>;',
        ] });
        if (result.status !== 'ok') throw new Error('Expected web grammar engine');
        expect(result.symbols.map(entry => entry.name)).toEqual(['Props', 'label', 'Card']);
    });

    it.each([
        ['typescript', ['export class Box {', '    value: number = 1;', '    read(): number { return Math.max(this.value, 0); }', '}', 'export type Name = Box;', 'export function create(): Box { return new Box(); }'], ['Box', 'value', 'read', 'Name', 'create']],
        ['python', ['class Box:', '    def read(self):', '        return self.value()', '', 'def create():', '    return Box()'], ['Box', 'read', 'create']],
        ['rust', ['pub struct Box { value: usize }', 'impl Box {', '    pub fn read(&self) -> usize { self.value }', '}', 'pub fn create() -> Box { Box { value: 1 } }'], ['Box', 'read', 'create']],
    ] as const)('extracts declarations and excludes calls and referenced types in %s', async (language, lines, names) => {
        const result = await loadDocumentOutlineBaseline({ isDark: false, language, lines });
        if (result.status !== 'ok') throw new Error('Expected web grammar engine');
        const outline = result.symbols;
        expect(outline.map(entry => entry.name)).toEqual(names);
        expect(outline.find(entry => entry.name === 'read')).toMatchObject({ line: language === 'rust' ? 3 : language === 'python' ? 2 : 3, depth: 1 });
    });

    it('groups Markdown headings by heading depth and ignores a heading inside a fence', async () => {
        const lines = ['# Title', '## Details', '```ts', '# not a heading', '```', '### More'];
        const result = await loadDocumentOutlineBaseline({ isDark: false, language: 'markdown', lines });
        if (result.status !== 'ok') throw new Error('Expected web grammar engine');
        expect(result.symbols).toEqual([
            { name: 'Title', kind: 'heading', line: 1, column: 2, depth: 0 },
            { name: 'Details', kind: 'heading', line: 2, column: 3, depth: 1 },
            { name: 'More', kind: 'heading', line: 6, column: 4, depth: 2 },
        ]);
    });
});
