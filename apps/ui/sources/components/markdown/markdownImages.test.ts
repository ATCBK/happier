import { describe, expect, it } from 'vitest';

import { parseMarkdown } from './parseMarkdown';
import { splitMarkdownRenderSegments } from './rendering/splitMarkdownRenderSegments';
import { projectMarkdownFindText } from './rendering/markdownFindProjection';
import { mapRenderedSelectionToMarkdownSource } from './rendering/markdownSelectionSource';
import { applyEnrichedMarkdownImagePolicy, normalizeMarkdownLinkUrl } from './enriched/enrichedMarkdownLinkHandling';
import { buildMarkdownImageDocument } from './markdownImages';
import { STREAMING_INCOMPLETE_LINK_HREF } from './streaming/streamingMarkdownRepairConfig';

describe('opt-in Markdown document images', () => {
    const markdown = 'Intro ![badge](https://remote.test/badge.png)\n\n![Screen](./screen(1).png "Title")\n\n![Remote](https://remote.test/shot.png)';

    it('keeps local file links and anchors available to the workspace link handler', () => {
        expect(normalizeMarkdownLinkUrl('a.pdf')).toBeNull();
        expect(normalizeMarkdownLinkUrl('a.pdf', { workspaceFileLinks: true })).toBe('a.pdf');
        expect(normalizeMarkdownLinkUrl('spec:draft.pdf', { workspaceFileLinks: true })).toBe('spec:draft.pdf');
        expect(normalizeMarkdownLinkUrl('#section', { workspaceFileLinks: true })).toBe('#section');
        expect(normalizeMarkdownLinkUrl('javascript:alert(1)')).toBeNull();
        expect(normalizeMarkdownLinkUrl(STREAMING_INCOMPLETE_LINK_HREF)).toBeNull();
    });

    it('never resolves the streaming repair placeholder as a document image', () => {
        const document = buildMarkdownImageDocument({ markdown: `![Pending](${STREAMING_INCOMPLETE_LINK_HREF})`, images: {
            resolve: path => ({ kind: 'workspace', path }), remoteLoaded: false, onLoadRemote() {},
        } });
        expect(document.images).toEqual([]);
    });

    it('extracts only dedicated image paragraphs, leaving transcript parsing unchanged', () => {
        expect(parseMarkdown(markdown).some(block => block.type === 'image')).toBe(false);
        expect(parseMarkdown(markdown, { imagesEnabled: true }).filter(block => block.type === 'image')).toEqual([
            { type: 'image', alt: 'Screen', destination: './screen(1).png' },
            { type: 'image', alt: 'Remote', destination: 'https://remote.test/shot.png' },
        ]);
        expect(parseMarkdown('Prose\n![inline](a.png)\nmore', { imagesEnabled: true }).some(block => block.type === 'image')).toBe(false);
        expect(parseMarkdown('Prose ![inline](a.png)', { imagesEnabled: true })).toEqual([
            { type: 'text', content: [{ styles: [], text: 'Prose inline', url: null }] },
        ]);
        expect(parseMarkdown('```md\n![code](a.png)\n```', { imagesEnabled: true })[0]?.type).toBe('code-block');
    });

    it('makes image segments opt-in without contaminating the ordinary static cache', () => {
        const ordinary = splitMarkdownRenderSegments({ markdown, streamingMode: 'static' });
        const images = splitMarkdownRenderSegments({ markdown, streamingMode: 'static', imagesEnabled: true });
        expect(images.map(segment => segment.type)).toEqual(['enriched-markdown', 'special-block', 'special-block']);
        expect(images.flatMap(segment => segment.type === 'special-block' ? segment.blocks : [])).toContainEqual({ type: 'image', alt: 'Screen', destination: './screen(1).png' });
        expect(splitMarkdownRenderSegments({ markdown, streamingMode: 'static' })).toBe(ordinary);
    });

    it('omits standalone image lines from enriched output only when the owner opts in', () => {
        expect(applyEnrichedMarkdownImagePolicy(markdown)).toContain('Screen');
        expect(applyEnrichedMarkdownImagePolicy(markdown, { imagesEnabled: true })).toBe('Intro badge\n\n\n\n');
    });

    it('projects the document gallery and remote count from the same blocks without loading a destination', () => {
        const document = buildMarkdownImageDocument({ markdown, images: {
            resolve: destination => destination.startsWith('https:') ? { kind: 'remote', url: destination } : { kind: 'workspace', path: 'docs/screen(1).png' },
            remoteLoaded: false,
            onLoadRemote() {},
        } });
        expect(document.images.map(image => [image.alt, image.source.kind])).toEqual([['Screen', 'workspace'], ['Remote', 'remote']]);
        expect(document.remoteImageCount).toBe(1);
        expect(document.gallery.map(image => image.alt)).toEqual(['Screen']);
    });

    it('keeps image alt text findable and selectable at its exact source offsets', () => {
        const source = '![Screen reader](./a.png)';
        expect(projectMarkdownFindText(source).text).toBe('Screen reader');
        expect(mapRenderedSelectionToMarkdownSource({ markdown: source, rendered: 'Screen reader', start: 0, end: 13 })).toEqual({ start: 2, end: 15 });
    });

    it('keeps non-image file references out of the image gallery', () => {
        const document = buildMarkdownImageDocument({ markdown: '![Clip](clip.mp4)\n\n![Photo](photo.png)', images: {
            resolve: path => ({ kind: 'workspace', path }), remoteLoaded: false, onLoadRemote() {},
        } });
        expect(document.images.map(image => image.alt)).toEqual(['Clip', 'Photo']);
        expect(document.gallery.map(image => image.alt)).toEqual(['Photo']);
    });
});
