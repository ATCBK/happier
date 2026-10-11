import { describe, expect, it } from 'vitest';

import { tokenizeSimpleSyntaxText } from './simpleSyntaxTokenizer';

describe('simpleSyntaxTokenizer', () => {
    it('tokenizes multi-line input and preserves newlines', () => {
        const tokens = tokenizeSimpleSyntaxText({
            text: ['const x = 1;', '// hello'].join('\n'),
            language: 'ts',
        });

        expect(tokens.some((t) => t.text === '\n')).toBe(true);
        expect(tokens.some((t) => t.type === 'keyword' && t.text.includes('const'))).toBe(true);
        expect(tokens.some((t) => t.type === 'number' && t.text.includes('1'))).toBe(true);
        expect(tokens.some((t) => t.type === 'comment' && t.text.includes('// hello'))).toBe(true);
    });

    it('uses hash comments for shell-family languages, so a URL stays code', () => {
        const bash = tokenizeSimpleSyntaxText({ text: 'curl -fsSL https://happier.dev/install | bash # installs the CLI', language: 'bash' });
        expect(bash.filter((t) => t.type === 'comment').map((t) => t.text)).toEqual(['# installs the CLI']);

        const powershell = tokenizeSimpleSyntaxText({ text: 'irm https://happier.dev/install.ps1 | iex', language: 'powershell' });
        expect(powershell.some((t) => t.type === 'comment')).toBe(false);

        const yaml = tokenizeSimpleSyntaxText({ text: 'url: https://happier.dev # docs', language: 'yaml' });
        expect(yaml.filter((t) => t.type === 'comment').map((t) => t.text)).toEqual(['# docs']);
    });

    it('does not highlight generic programming keywords inside markdown text', () => {
        const tokens = tokenizeSimpleSyntaxText({
            text: 'This is a doc line for people.',
            language: 'markdown',
        });

        expect(tokens.some((t) => t.type === 'keyword')).toBe(false);
    });
});
