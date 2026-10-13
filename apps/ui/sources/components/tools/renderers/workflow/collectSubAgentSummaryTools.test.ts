import { describe, expect, it } from 'vitest';

import { createToolCallMessageFixture, makeToolCall } from '@/dev/testkit';
import { collectSubAgentSummaryTools } from './collectSubAgentSummaryTools';

describe('collectSubAgentSummaryTools', () => {
    it('renders the canonical MCP title instead of the provider wire name', () => {
        const tool = makeToolCall({ name: 'Task', state: 'running', createdAt: 10, startedAt: 10 });
        const message = createToolCallMessageFixture({
            id: 'm1',
            createdAt: 11,
            tool: makeToolCall({
                name: 'mcp__filesystem__read_file',
                state: 'completed',
                input: { path: '/repo/readme.md' },
                createdAt: 11,
            }),
        });

        const tools = collectSubAgentSummaryTools({ tool, messages: [message], metadata: null });
        expect(tools).toHaveLength(1);
        expect(tools[0]?.title).toBe('MCP: Filesystem Read File');
    });

    it('sorts eligible task tools oldest first and excludes earlier or nested task calls', () => {
        const tool = makeToolCall({ name: 'Task', state: 'running', createdAt: 10, startedAt: 10 });
        const messages = [
            createToolCallMessageFixture({ id: 'm2', tool: makeToolCall({ name: 'ToolB', state: 'completed', createdAt: 12 }) }),
            createToolCallMessageFixture({ id: 'early', tool: makeToolCall({ name: 'ToolEarly', state: 'completed', createdAt: 9 }) }),
            createToolCallMessageFixture({ id: 'nested', tool: makeToolCall({ name: 'Task', state: 'running', createdAt: 13 }) }),
            createToolCallMessageFixture({ id: 'm1', tool: makeToolCall({ name: 'ToolA', state: 'error', createdAt: 11 }) }),
        ];

        const tools = collectSubAgentSummaryTools({ tool, messages, metadata: null });
        expect(tools.map((entry) => entry.tool.createdAt)).toEqual([11, 12]);
        expect(tools.map((entry) => entry.state)).toEqual(['error', 'completed']);
    });
});
