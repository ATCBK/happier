import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';

// The vendor's browser reveal adapter cannot run in the Node renderer.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

describe('ReasoningView', () => {
    function makeTool(result: ToolCall['result']): ToolCall {
        return makeToolCall({
            name: 'GeminiReasoning',
            state: 'completed',
            input: { title: 'Thinking' },
            result,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { ReasoningView } = await import('./ReasoningView');
        return renderScreen(React.createElement(
            ReasoningView,
            makeToolViewProps(tool, { sessionId: 's1', ...(detailLevel ? { detailLevel } : {}) }),
        ));
    }

    it('renders tool.result.content through the real markdown view', async () => {
        const screen = await renderView(makeTool({ content: 'Hello **world**' }));
        expect(screen.getTextContent()).toBe('Hello **world**');
    });

    it('truncates long reasoning by default and preserves full content when detailLevel=full', async () => {
        const long = 'x'.repeat(2000);
        const tool = makeTool({ content: long });
        const summary = await renderView(tool);
        expect(summary.getTextContent().length).toBeLessThan(long.length);
        expect(summary.getTextContent().endsWith('…')).toBe(true);

        const full = await renderView(tool, 'full');
        expect(full.getTextContent()).toBe(long);
    });

    it('supports string/text/reasoning result fallbacks and ignores malformed payloads', async () => {
        for (const [result, expected] of [
            ['plain text result', 'plain text result'],
            [{ text: 'text field' }, 'text field'],
            [{ reasoning: 'reasoning field' }, 'reasoning field'],
        ] as const) {
            const screen = await renderView(makeTool(result));
            expect(screen.getTextContent()).toBe(expected);
        }
        const malformed = await renderView(makeTool({ content: 123 }));
        expect(malformed.getTextContent()).toBe('');
    });

    it('projects only rendered reasoning and reveals a match beyond the summary clamp', async () => {
        const module = await import('./ReasoningView');
        const markdown = 'x'.repeat(1200) + '**needle**';
        const tool = makeTool({ content: markdown, hiddenMetadata: 'private needle' });
        expect(module.projectReasoningDisplayText(tool)).toEqual([
            { id: 'tool-reasoning', text: markdown, format: 'markdown', kind: 'toolBody' },
        ]);
        const store = createTranscriptFindRowStore();
        const ranges = [{ start: 1202, end: 1208, current: true }];
        store.publish(new Map([['m1', { blocks: [{ id: 'tool-reasoning', sourceRanges: ranges }] }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}>
            <module.ReasoningView {...makeToolViewProps(tool, { messageId: 'm1' })} />
        </TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain('needle');
        expect(screen.getTextContent()).not.toContain('…');
        expect(screen.tree.findByTestId('find-match-current')?.props.children).toBe('needle');
    });
});
