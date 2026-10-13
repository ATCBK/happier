import React from 'react';
import { describe, expect, it } from 'vitest';
import renderer from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';


describe('EnterPlanModeView', () => {
    function makeTool(): ToolCall {
        return makeToolCall({
            name: 'EnterPlanMode',
            state: 'completed',
            input: {},
            result: null,
            permission: undefined,
        });
    }

    async function renderView(detailLevel?: 'title' | 'summary' | 'full') {
        const { EnterPlanModeView } = await import('./EnterPlanModeView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(
                    EnterPlanModeView,
                    makeToolViewProps(makeTool(), detailLevel ? { detailLevel } : {}),
                ))).tree;
        return tree;
    }

    it('renders a compact marker by default', async () => {
        const tree = await renderView();
        const joined = collectHostText(tree).join(' ');
        expect(joined).toContain('Entered plan mode');
        expect(joined).not.toContain('structured plan');
    });

    it('renders the compact marker in summary mode', async () => {
        const tree = await renderView('summary');
        const joined = collectHostText(tree).join(' ');
        expect(joined).toContain('Entered plan mode');
        expect(joined).not.toContain('structured plan');
    });

    it('renders the full explanation when detailLevel=full', async () => {
        const tree = await renderView('full');
        const joined = collectHostText(tree).join(' ');
        expect(joined).toContain('structured plan');
    });

    it('renders nothing when detailLevel=title', async () => {
        const tree = await renderView('title');
        expect(collectHostText(tree)).toEqual([]);
    });
});
