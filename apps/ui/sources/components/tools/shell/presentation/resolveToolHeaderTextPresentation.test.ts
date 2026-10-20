import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from "@happier-dev/session-core/messages";

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        KnownTool: {
            title: 'Known title',
            extractSubtitle: () => 'Known subtitle',
            extractStatus: () => 'Running',
        },
    },
}));

let inferred: { normalizedToolName: string; source: string } = { normalizedToolName: 'UnknownTool', source: 'original' };
vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: () => inferred,
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => `MCP:${name}`,
    formatMCPToolSubtitle: (_name: string, input: any) => `sub:${String(input?.x ?? '')}`,
}));

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    const now = 1;
    return {
        name: 'UnknownTool',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

describe('resolveToolHeaderTextPresentation', () => {
    it.each([{ kind: 'person' }, { kind: 'session', sessionId: 'manager' }] as const)(
        'reads the completed question byline for $kind without using authored answer labels', async answeredBy => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'AskUserQuestion',
            input: { answeredBy: { kind: 'session', sessionId: 'forged' } },
            permission: { id: 'question', kind: 'user_action', status: 'approved', answeredBy } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null,
            answeringSession: { sessionId: 'manager', name: 'Daily' } });
        expect(model.answeredBy).toEqual(answeredBy);
        expect(model.answeredByLabel).toBeTruthy();
        expect(resolveToolHeaderTextPresentation({ tool: { ...tool, permission: { ...tool.permission!, answeredBy: undefined } },
            metadata: null }).answeredByLabel).toBeNull();
    });

    it('reads an unknown snake_case tool id as words, not as the raw identifier', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'codex_command_execution' });
        inferred = { normalizedToolName: 'codex_command_execution', source: 'original' };
        expect(resolveToolHeaderTextPresentation({ tool, metadata: null }).title).toBe('Codex command execution');
    });

    it('uses tool name as title when inference did not fall back', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'UnknownTool', description: 'Execute' });
        inferred = { normalizedToolName: 'UnknownTool', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('UnknownTool');
        expect(model.subtitle).toBeNull();
    });

    it('uses description as title when inference fell back and tool is unknown', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'UnknownTool', description: 'Search files' });
        inferred = { normalizedToolName: 'SomeInferred', source: 'description' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Search files');
    });

    it('uses known tool title/subtitle/status when available', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'KnownTool', description: 'Execute' });
        inferred = { normalizedToolName: 'KnownTool', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Known title');
        expect(model.subtitle).toBe('Known subtitle');
        expect(model.statusText).toBe('Running');
    });

    it('uses MCP title and subtitle for mcp__ tools', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'mcp__foo', input: { x: 1 } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('MCP:mcp__foo');
        expect(model.subtitle).toBe('sub:1');
    });

    it('compacts SubAgentRun JSON subtitle to summary text', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({
            name: 'SubAgentRun',
            description:
                '{"status":"timeout","summary":"Timed out after 120000ms","error":{"code":"execution_run_timeout","message":"Timed out after 120000ms"}}',
        });
        inferred = { normalizedToolName: 'SubAgentRun', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('SubAgentRun');
        expect(model.subtitle).toBe('Timed out after 120000ms');
    });
});
