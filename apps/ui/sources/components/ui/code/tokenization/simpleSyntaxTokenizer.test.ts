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

    it('keeps digits inside shell words (hosts, versions) as part of the word', () => {
        const tokens = tokenizeSimpleSyntaxText({ text: 'ssh dev@host-01.example.com -p 2222 ubuntu-24.04', language: 'bash' });
        expect(tokens.filter((t) => t.type === 'number').map((t) => t.text)).toEqual(['2222']);
    });

    it('keeps signed and listed numbers as numbers outside shell languages', () => {
        const yaml = tokenizeSimpleSyntaxText({ text: 'ports:\n- 8080\nscale: -1', language: 'yaml' });
        expect(yaml.filter((t) => t.type === 'number').map((t) => t.text)).toEqual(['8080', '1']);
        const r = tokenizeSimpleSyntaxText({ text: 'x <- -2', language: 'r' });
        expect(r.filter((t) => t.type === 'number').map((t) => t.text)).toEqual(['2']);
    });

    it('does not highlight generic programming keywords inside markdown text', () => {
        const tokens = tokenizeSimpleSyntaxText({
            text: 'This is a doc line for people.',
            language: 'markdown',
        });

        expect(tokens.some((t) => t.type === 'keyword')).toBe(false);
    });
});
