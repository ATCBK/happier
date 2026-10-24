// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { enrichedMarkdownPackageFileUrl } from '@/dev/testkit/harness/enrichedMarkdownPackage';
import { normalizeMarkdownLinkUrl, sanitizeEnrichedMarkdownLinkTargets } from './enrichedMarkdownLinkHandling';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type WebMarkdownModule = Readonly<{
    EnrichedMarkdownText: React.ComponentType<{ markdown: string }>;
}>;

describe('untrusted language-server documentation Markdown', () => {
    it('renders raw HTML inert while preserving documentation formatting and ordinary links', async () => {
        const parserUrl = enrichedMarkdownPackageFileUrl('src/web/parseMarkdown.ts');
        const parser = await import(/* @vite-ignore */ parserUrl) as { preloadMarkdownRuntime: () => Promise<void> };
        await parser.preloadMarkdownRuntime();
        const rendererUrl = enrichedMarkdownPackageFileUrl('src/web/EnrichedMarkdownText.tsx');
        const { EnrichedMarkdownText } = await import(/* @vite-ignore */ rendererUrl) as WebMarkdownModule;
        // The installed package's source JSX uses the classic React runtime.
        const previousReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
        (globalThis as typeof globalThis & { React?: typeof React }).React = React;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            const markdown = [
                '**Documentation** with `code`, [reference](https://example.com/docs), and [guide][safe].',
                '',
                '<script>globalThis.documentationExecuted = true</script>',
                '<img src="https://tracking.invalid/pixel" onerror="globalThis.documentationExecuted = true">',
                '<a href="command:open?src/file.ts">HTML command</a>',
                '',
                '[Run command](command:open?src/file.ts) <command:open?src/file.ts>',
                '[Escaped command](command\\:open?src/file.ts)',
                '[Encoded command](command&#58;open?src/file.ts)',
                '',
                '[Referenced command][execute]',
                '',
                '[execute]: command:open?src/file.ts',
                '[safe]: <https://example.com/guide> "Guide"',
                '',
                '```markdown',
                '[literal]: command:open?src/file.ts',
                '```',
            ].join('\n');
            await act(async () => {
                root.render(<EnrichedMarkdownText markdown={sanitizeEnrichedMarkdownLinkTargets(markdown)} />);
            });
            expect(container.querySelector('strong')?.textContent).toBe('Documentation');
            expect(container.querySelector('code')?.textContent).toBe('code');
            expect(Array.from(container.querySelectorAll('a')).map((link) => link.getAttribute('href')))
                .toEqual(['https://example.com/docs', 'https://example.com/guide']);
            expect(container.querySelector('script, img, iframe, object')).toBeNull();
            expect(container.textContent).toContain('<script>');
            expect(container.textContent).toContain('Run command');
            expect(container.textContent).toContain('[literal]: command:open?src/file.ts');
        } finally {
            await act(async () => root.unmount());
            container.remove();
            (globalThis as typeof globalThis & { React?: typeof React }).React = previousReact;
        }
    });

    it('rejects executable URI schemes before a slash can make them look like workspace paths', () => {
        for (const target of ['command:open?src/file.ts', 'CoMmAnD:open?src\\file.ts', 'vscode://file/src/file.ts']) {
            expect(normalizeMarkdownLinkUrl(target)).toBeNull();
        }
        for (const target of ['https://example.com/docs', 'src/file.ts', './file.ts', 'C:\\repo\\file.ts', 'C:/repo/file.ts']) {
            expect(normalizeMarkdownLinkUrl(target)).toBe(target);
        }
    });
});
