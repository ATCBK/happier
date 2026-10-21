import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const openExternalUrl = vi.fn(async (_url: string) => undefined);
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }));

describe('MarkdownView inline references', () => {
    it('follows Markdown code boundaries rather than treating an unmatched backtick as code', async () => {
        const { sanitizeEnrichedMarkdownWithInlineReferences } = await import('./enriched/enrichedMarkdownLinkHandling');
        const resolve = () => ({ label: 'Chip', foreground: '#111', background: '#eee' });
        expect(sanitizeEnrichedMarkdownWithInlineReferences('Literal ` and [bound](happier-ref:session:s1)', { scheme: 'session', resolve }).markdown)
            .toBe('Literal ` and [Chip](happier-ref:session:s1)');
        expect(sanitizeEnrichedMarkdownWithInlineReferences('~~~md\n[code](happier-ref:session:s1)\n~~~', { scheme: 'session', resolve }).markdown)
            .toBe('~~~md\ncode\n~~~');
    });

    it('keeps tokens in inline and fenced code as readable text without resolving them', async () => {
        const { sanitizeEnrichedMarkdownWithInlineReferences } = await import('./enriched/enrichedMarkdownLinkHandling');
        const resolve = vi.fn(() => ({ label: 'Chip', foreground: '#111', background: '#eee' }));
        const result = sanitizeEnrichedMarkdownWithInlineReferences(
            '`[code](happier-ref:file:src/a.ts)`\n\n```md\n[fenced](happier-ref:file:src/b.ts)\n```', { scheme: 'file', resolve },
        );
        expect(result.markdown).toBe('`code`\n\n```md\nfenced\n```');
        expect(result.references.size).toBe(0);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('resolves an already-prefixed reference once and keeps unowned links inert', async () => {
        const { sanitizeEnrichedMarkdownWithInlineReferences } = await import('./enriched/enrichedMarkdownLinkHandling');
        const reference = { label: 'Current title', glyph: 'conversations' as const, thumbnail: { uri: 'data:image/png;base64,aA==' }, foreground: '#111', background: '#eee' };
        const resolve = vi.fn((ref: string) => ref === 's1' ? reference : null);
        const result = sanitizeEnrichedMarkdownWithInlineReferences(
            'See [old](happier-ref:session:s1) and [unbound](happier-ref:session:s2).', { scheme: 'session', resolve },
        );
        expect(result.markdown).toBe('See [Current title](happier-ref:session:s1) and unbound.');
        expect(result.references.get('happier-ref:session:s1')).toEqual(reference);
        expect(resolve).toHaveBeenCalledWith('s1');
        expect(sanitizeEnrichedMarkdownWithInlineReferences('[lookalike](happier-ref:file:src/@a.ts)').markdown).toBe('lookalike');
    });

    it('draws a cited reference inline with the owner’s label and hands its press to the owner, never opening it', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPress = vi.fn();
        const references = {
            scheme: 'finding',
            resolve: (target: string) => (target === 'codex-run:f1'
                ? { label: 'High · Codex', foreground: '#c00', background: '#fee' }
                : null),
            onPress,
        };
        const screen = await renderScreen(
            <MarkdownView
                markdown={'It now calls the same hook, which leaves one case open [the sheet](finding:codex-run:f1); [gone](finding:other) stays text.'}
                inlineReferences={references}
            />,
        );

        const run = screen.findAllByType('EnrichedMarkdownText')[0]!;
        // The citation sits where the narrator put it, labelled by the owner; an unknown one is plain text.
        expect(run.props.markdown).toContain('open [High · Codex](happier-ref:finding:codex-run:f1);');
        expect(run.props.markdown).toContain('; gone stays text.');

        await act(async () => { run.props.onLinkPress({ url: 'happier-ref:finding:codex-run:f1' }); });
        expect(onPress).toHaveBeenCalledWith('codex-run:f1');
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    it('leaves a reference link as plain text when nobody owns its scheme', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const screen = await renderScreen(<MarkdownView markdown={'See [the sheet](finding:codex-run:f1) here.'} />);
        expect(screen.findAllByType('EnrichedMarkdownText')[0]!.props.markdown).toBe('See the sheet here.');
    });

    it('carries plugin citation severity and presses through the mounted presentation host', async () => {
        const { Markdown } = await import('@happier-dev/plugin-ui/components');
        const { PluginUiPresentationHostProviderInternal } = await import('../../../../../packages/plugin-ui/src/presentationHost/context');
        const { createPluginUiPrivatePresentationHost } = await import('@/components/plugins/surfaces/pluginUiPrivatePresentationHost');
        const { sanitizeEnrichedMarkdownWithInlineReferences } = await import('./enriched/enrichedMarkdownLinkHandling');
        const { MarkdownView } = await import('./MarkdownView');
        const onPress = vi.fn();
        const reference = { label: 'High · Plugin', severity: 'high' as const, foreground: '#c00', background: '#fee' };
        const inlineReferences = { scheme: 'plugin-finding', resolve: (target: string) => target === 'f1' ? reference : null, onPress };
        const screen = await renderScreen(
            <PluginUiPresentationHostProviderInternal host={createPluginUiPrivatePresentationHost(undefined)}>
                <Markdown value="See [the finding](plugin-finding:f1)." inlineReferences={inlineReferences} />
            </PluginUiPresentationHostProviderInternal>,
        );
        const markdown = screen.findByType(MarkdownView);
        const sanitized = sanitizeEnrichedMarkdownWithInlineReferences(markdown.props.markdown, markdown.props.inlineReferences);
        expect(sanitized.references.get('happier-ref:plugin-finding:f1')).toEqual(reference);
        const run = screen.findAllByType('EnrichedMarkdownText')[0]!;
        expect(run.props.markdown).toBe('See [High · Plugin](happier-ref:plugin-finding:f1).');
        await act(async () => { run.props.onLinkPress({ url: 'happier-ref:plugin-finding:f1' }); });
        expect(onPress).toHaveBeenCalledWith('f1');
        expect(openExternalUrl).not.toHaveBeenCalled();
    });
});
