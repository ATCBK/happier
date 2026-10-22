import { enrichedMarkdownPackageFileUrl } from '@/dev/testkit/harness/enrichedMarkdownPackage';
import { describe, expect, it } from 'vitest';
import { projectMarkdownFindSpans, projectMarkdownFindText } from './markdownFindProjection';

describe('projectMarkdownFindText', () => {
    it('preserves code Find offsets in a mixed custom-options and code segment', () => {
        const markdown = '<options>\n<option>choose</option>\n</options>\n```ts\nneedle\n```';
        const projected = projectMarkdownFindText(markdown);
        expect(projected.text).toBe('chooseneedle');
        expect(projected.sourceOffsets.slice(-6)).toEqual(Array.from({ length: 6 }, (_, index) => markdown.indexOf('needle') + index));
    });

    it.each([
        '> **needle**\n> second needle\n>\n>   ```ts\n>   needle\n>     needle\n>   ```',
        '- Review\n\n      needle\n        needle',
        '    needle\n      needle',
    ])('maps every nested and indented occurrence back to its original source: %s', markdown => {
        const projected = projectMarkdownFindText(markdown);
        const displayed = [...projected.text.matchAll(/needle/g)].map(match => projected.sourceOffsets[match.index]);
        expect(displayed).toEqual([...markdown.matchAll(/needle/g)].map(match => match.index));
        expect(projected.sourceOffsets).toHaveLength(projected.text.length);
        expect(projected.sourceEnds).toHaveLength(projected.text.length);
        expect(projected.text).not.toContain('```');
    });

    it('projects nested prose and code with source offsets after container and fence indentation is removed', () => {
        const markdown = '- **Review needle**\n\n    ```ts\n    const needle = 1;\n    ```';
        const projected = projectMarkdownFindText(markdown);
        expect(projected.text).toBe('Review needle\nconst needle = 1;');
        const needles = [...projected.text.matchAll(/needle/g)].map(match => projected.sourceOffsets[match.index]);
        expect(needles).toEqual([...markdown.matchAll(/needle/g)].map(match => match.index));
    });

    it('projects canonical Markdown text and maps repeated labels across hidden destinations and markup', () => {
        const markdown = '# **same** [same](https://hidden/same) 😀';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('same same 😀');
        expect(result.sourceOffsets.slice(0, 4)).toEqual([4, 5, 6, 7]);
        expect(result.sourceOffsets.slice(5, 9)).toEqual([12, 13, 14, 15]);
        expect(result.sourceOffsets.slice(-2)).toEqual([39, 40]);
        expect(result.sourceEnds.slice(-2)).toEqual([40, 41]);
    });

    it('matches actual enriched escape and omitted-entity behavior, but preserves inline code literally', () => {
        const markdown = '\\* &amp; &#x1F600; `&amp; \\*`';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('*   &amp; \\*');
        expect(result.sourceOffsets.slice(0, 4)).toEqual([1, 2, 8, 18]);
        expect(result.sourceEnds.slice(0, 4)).toEqual([2, 3, 9, 19]);
    });

    it('uses special block display text rather than fence syntax, language, or option tags', () => {
        const markdown = '```ts\nconst 😀 = 1;\n```\n\n<options>\n<option>choose **literally**</option>\n</options>';
        const result = projectMarkdownFindText(markdown);
        expect(result.text).toBe('const 😀 = 1;\nchoose **literally**');
        expect(result.sourceOffsets.slice(0, 5)).toEqual([6, 7, 8, 9, 10]);
        expect(result.sourceEnds).toHaveLength(result.text.length);
    });

    it('excludes diagram media and error-source fallback without making text coverage incomplete', () => {
        const result = projectMarkdownFindText('```mermaid\nflowchart LR\nA --> B\n```\n\nvisible needle');
        expect(result.text).toBe('visible needle');
        expect(result).not.toHaveProperty('incomplete');
        expect(projectMarkdownFindText('**visible needle**')).not.toHaveProperty('incomplete');
        expect(projectMarkdownFindText('```txt\nflowchart LR\nA --> B\n```')).not.toHaveProperty('incomplete');
    });

    it('maps code lines after the canonical fence parser removes indentation', () => {
        const source = '   ```txt\n   same\n    same\n   ```';
        const projected = projectMarkdownFindText(source);
        expect(projected.text).toBe('same\n same');
        expect(projected.sourceOffsets[0]).toBe(source.indexOf('same'));
        expect(projected.sourceOffsets[6]).toBe(source.lastIndexOf('same'));
    });

    it('ignores reference definitions and container markers while retaining link labels', () => {
        expect(projectMarkdownFindText('> [shown][ref]\n\n[ref]: https://secret').text).toBe('shown');
        expect(projectMarkdownFindText('- [x] **done**\n- next').text).toBe('done\nnext');
        expect(projectMarkdownFindText('> first\n> second').text).toBe('first\nsecond');
    });

    it('preserves nested display styles and original offsets after the render owner indents loose list continuations', () => {
        const spans = projectMarkdownFindSpans('**bold *nested***');
        expect(spans.find((span) => span.text === 'nested')).toMatchObject({ styles: ['bold', 'italic'] });
        expect(projectMarkdownFindSpans('~~settled~~').find((span) => span.text === 'settled')).toMatchObject({ styles: ['strikethrough'] });
        const source = '1. **Heading**\n\nBody sentence.\n\n2. **Next**';
        const projected = projectMarkdownFindText(source);
        const index = projected.text.indexOf('Body');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(projected.sourceOffsets[index]).toBe(source.indexOf('Body'));
    });

    it('agrees with the real enriched md4c text leaves for nested, escaped, reference and entity fixtures', async () => {
        // Load the actual pinned web parser rather than the UI testkit native-view stub.
        const parserUrl = enrichedMarkdownPackageFileUrl('lib/module/web/parseMarkdown.js');
        const runtime: unknown = await import(/* @vite-ignore */ parserUrl);
        if (typeof runtime !== 'object' || runtime === null || !('parseMarkdown' in runtime) || typeof runtime.parseMarkdown !== 'function') {
            throw new Error('Pinned enriched parser unavailable');
        }
        const readText = (node: unknown): string => {
            if (typeof node !== 'object' || node === null) return '';
            const value = node as Record<string, unknown>;
            if (value.type === 'LineBreak') return '\n';
            const children = Array.isArray(value.children) ? value.children : [];
            return (typeof value.content === 'string' ? value.content : '') + children.map(readText).join('');
        };
        for (const source of ['**bold *nested***', '\\* &amp; &#x1F600; `&amp;`', '[shown][ref]\n\n[ref]: https://hidden', '<i>visible</i>', '# heading ###', 'heading\n====', ' visible 😀 ', 'a \nb', 'a  \nb', 'a\n  b']) {
            const ast: unknown = await runtime.parseMarkdown(source);
            expect(projectMarkdownFindText(source).text).toBe(readText(ast));
        }
    });

    it('keeps escaped-pipe table text searchable with original offsets across header, formatted, code and repeated cells', () => {
        const markdown = [
            '<options>',
            '<option>Choose</option>',
            '</options>',
            '| Name \\| target | Detail |',
            '|---|---|',
            '| **same \\| target** | `same \\| target` |',
            '| same \\| target | 😀 |',
            '<options>',
            '<option>target</option>',
            '</options>',
        ].join('\r\n');
        const projected = projectMarkdownFindText(markdown);
        expect(projected.text).toBe('Choose\nName | target\nDetail\nsame | target\nsame | target\nsame | target\n😀\ntarget');
        const targets = [...projected.text.matchAll(/target/g)].map((match) => match.index);
        const sourceTargets = [...markdown.matchAll(/target/g)].map((match) => match.index);
        expect(targets.map((index) => projected.sourceOffsets[index])).toEqual(sourceTargets);
        expect(targets.map((index) => projected.sourceEnds[index + 5])).toEqual(sourceTargets.map((index) => index + 6));
        const pipes = [...projected.text.matchAll(/\|/g)].map((match) => match.index);
        expect(pipes.map((index) => projected.sourceOffsets[index])).toEqual(
            [...markdown.matchAll(/\\\|/g)].map((match) => match.index + 1),
        );
        const emoji = markdown.indexOf('😀');
        const displayedEmoji = projected.text.indexOf('😀');
        expect(projected.sourceOffsets.slice(displayedEmoji, displayedEmoji + 2)).toEqual([emoji, emoji + 1]);
    });
});
