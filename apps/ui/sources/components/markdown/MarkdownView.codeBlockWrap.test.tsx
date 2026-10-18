import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { MarkdownView } from './MarkdownView';
import { MarkdownCodeBlockWrapStateProvider } from './MarkdownCodeBlockWrapState';

afterEach(standardCleanup);

describe('MarkdownView code block wrapping', () => {
    it('retains each message/block choice when virtualized rows unmount and remount', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```', 'identical content', '```', '', '```', 'identical content', '```'].join('\n');
        function Transcript({ visible }: Readonly<{ visible: boolean }>) {
            return (
                <MarkdownCodeBlockWrapStateProvider>
                    {visible ? <MarkdownView markdown={markdown} codeBlockStateKey="session:a/message:a" /> : null}
                    <MarkdownView markdown={markdown} codeBlockStateKey="session:a/message:b" />
                </MarkdownCodeBlockWrapStateProvider>
            );
        }
        const screen = await renderScreen(<Transcript visible />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        await pressTestInstanceAsync(switches()[0]!, 'wrap first message/block');
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false, false, false]);
        await screen.update(<Transcript visible={false} />);
        await screen.update(<Transcript visible />);
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false, false, false]);
    });

    it('toggles individual fenced blocks without changing the file/diff setting', async () => {
        storage.getState().applySettingsLocal({ wrapLinesInDiffs: true, filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```yaml', 'description: ' + 'long description '.repeat(30), '```', '', '```', 'same content', '```'].join('\n');
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        const scrollers = () => screen.findAllByTestId('markdown-code-block-scroll')
            .filter(node => typeof node.type === 'string');

        expect(switches()).toHaveLength(2);
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([false, false]);
        expect(scrollers()).toHaveLength(2);
        await pressTestInstanceAsync(switches()[0]!, 'first code block wrap');
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false]);
        expect(scrollers()).toHaveLength(1);
        expect(storage.getState().settings.wrapLinesInDiffs).toBe(true);
        await pressTestInstanceAsync(switches()[0]!, 'unwrap first code block');
        expect(scrollers()).toHaveLength(2);
    });

    it.each(['diff', 'patch'])('retains the local code wrap choice when switching a %s fence between modes', async (language) => {
        storage.getState().applySettingsLocal({ wrapLinesInDiffs: true, filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```' + language, 'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', '```'].join('\n');
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        expect(switches()).toHaveLength(0);
        await screen.pressByTestIdAsync('markdown-code-block-toggle:code');
        expect(switches()).toHaveLength(1);
        expect(switches()[0]!.props.accessibilityState.checked).toBe(false);
        await pressTestInstanceAsync(switches()[0]!, 'wrap code fence');
        expect(switches()[0]!.props.accessibilityState.checked).toBe(true);
        expect(screen.findAllByTestId('markdown-code-block-scroll')).toHaveLength(0);
        await screen.pressByTestIdAsync('markdown-code-block-toggle:diff');
        await screen.pressByTestIdAsync('markdown-code-block-toggle:code');
        expect(switches()[0]!.props.accessibilityState.checked).toBe(true);
        expect(storage.getState().settings.wrapLinesInDiffs).toBe(true);
    });

    it.each([
        { label: 'over-budget', budget: 1, content: 'a long plain line '.repeat(30) },
        { label: 'empty', budget: 1_000_000, content: '' },
    ])('keeps wrapping available for $label diff fences', async ({ budget, content }) => {
        storage.getState().applySettingsLocal({ filesDiffTokenizationMaxBytes: budget, filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'```diff\n' + content + '\n```'} />);
        await screen.pressByTestIdAsync('code-wrap-lines-toggle');
        expect(screen.findAllByTestId('markdown-code-block-scroll')).toHaveLength(0);
    });
});
