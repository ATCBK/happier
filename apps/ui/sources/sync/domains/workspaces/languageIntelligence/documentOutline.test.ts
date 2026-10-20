import { describe, expect, it } from 'vitest';

import { loadDocumentOutlineBaseline } from './loadDocumentOutlineBaseline';

describe('document outline', () => {
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
