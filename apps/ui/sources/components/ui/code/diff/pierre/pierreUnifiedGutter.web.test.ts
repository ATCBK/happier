// @vitest-environment jsdom

import { DiffHunksRenderer, FileDiff, getSingularPatch, parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, it, vi } from 'vitest';
import { buildPierreDiffOptionsBase } from './buildPierreDiffOptionsBase.web';

describe('Pierre unified old/new gutter', () => {
    it('renders the custom gutter utility slot in the real shadow DOM', async () => {
        const fileDiff = getSingularPatch('--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n');
        if (!fileDiff) throw new Error('Expected a parsed patch');
        // JSDOM omits constructed stylesheets and ResizeObserver; only these browser ports are replaced.
        const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
        Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        const host = document.createElement('diffs-container');
        document.body.append(host);
        let rendered: () => void = () => {};
        const ready = new Promise<void>(resolve => { rendered = resolve; });
        const viewer = new FileDiff({
            theme: 'pierre-light', diffStyle: 'unified', disableFileHeader: true,
            enableGutterUtility: true,
            renderGutterUtility: () => document.createElement('button'),
            onPostRender: node => { if (node.shadowRoot?.querySelector('[data-line]')) rendered(); },
        });
        try {
            viewer.hydrate({ fileDiff, fileContainer: host });
            await ready;
            viewer.setSelectedLines({ start: 1, end: 1, side: 'additions' });
            expect(host.shadowRoot?.querySelector('[data-gutter-utility-slot]')).toBeTruthy();
        } finally {
            viewer.cleanUp();
            host.remove();
            if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
            else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
            vi.unstubAllGlobals();
        }
    });
    it('renders genuine context expansion when both complete sources are available', async () => {
        const contents = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
        const fileDiff = parseDiffFromFile({ name: 'a.txt', contents }, { name: 'a.txt', contents: contents.replace('line 20', 'changed 20') }, { context: 3 });
        const renderer = new DiffHunksRenderer({ diffStyle: 'unified', theme: 'pierre-light', hunkSeparators: 'line-info', disableFileHeader: true });
        try {
            const rendered = await renderer.asyncRender(fileDiff);
            expect(renderer.renderFullHTML(rendered)).toContain('data-expand-button');
        } finally {
            renderer.cleanUp();
        }
    });
    it('names the hunk context and marks changed words without promising absent patch context', async () => {
        const patchText = '--- a/a.ts\n+++ b/a.ts\n@@ -5 +5 @@ export function example() {\n-const key = route.path + width;\n+const key = route.path;\n';
        const patch = getSingularPatch(patchText);
        if (!patch) throw new Error('Expected parsed patch');
        const renderer = new DiffHunksRenderer(buildPierreDiffOptionsBase({
            isDark: false, diffStyle: 'unified', patchText, wrapLines: true, showLineNumbers: true, showPrefix: true,
            tokenizeMaxLineLength: 1000, themeIds: { light: 'pierre-light', dark: 'pierre-dark' },
            intraLineDiff: { enabled: true, maxPatchLines: 2000, maxLineLength: 1000 },
        }));
        try {
            const rendered = await renderer.asyncRender(patch);
            const html = renderer.renderFullHTML(rendered);
            expect(html).toContain('data-hunk-context');
            expect(html).toContain('export function example()');
            expect(html).toContain('data-diff-span');
            expect(html).not.toContain('data-expand-button');
        } finally {
            renderer.cleanUp();
        }
    });

    it('keeps both source coordinates while preserving the interactive line identity', async () => {
        const patch = getSingularPatch([
            '--- a/a.txt', '+++ b/a.txt', '@@ -4,3 +9,3 @@',
            ' context', '-before', '+after', ' tail', '',
        ].join('\n'));
        if (!patch) throw new Error('Expected a parsed patch');
        const renderer = new DiffHunksRenderer({ diffStyle: 'unified', theme: 'pierre-light', disableFileHeader: true });
        try {
            const rendered = await renderer.asyncRender(patch);
            const rows = rendered.unifiedGutterAST?.filter((node) => node.type === 'element' && node.properties?.['data-column-number'] != null);
            expect(rows?.map((row) => row.type === 'element' ? [row.properties['data-column-number'], row.properties['data-old-line-number'], row.properties['data-new-line-number']] : [])).toEqual([
                [9, 4, 9], [5, 5, undefined], [10, undefined, 10], [11, 6, 11],
            ]);
            const html = renderer.renderFullHTML(rendered);
            expect(html).not.toContain('data-line-number-side');
            expect(html).not.toContain('data-old-line-number="undefined"');
            expect(html).not.toContain('data-new-line-number="undefined"');
        } finally {
            renderer.cleanUp();
        }
    });
});
