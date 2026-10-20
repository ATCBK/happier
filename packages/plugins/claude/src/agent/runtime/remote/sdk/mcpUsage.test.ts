import { describe, expect, it } from 'vitest';
import { createClaudeMcpUsageWitness } from './mcpUsage.js';

describe('native MCP usage coverage', () => {
    it('scopes inventory and calls to selected servers, including when Claude exposes other native connectors', () => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find', 'mcp__native_connector__find'] });
        witness.observe({ type: 'assistant', message: { content: [
            { type: 'tool_use', id: 'other-call', name: 'mcp__native_connector__find', input: {} },
        ] } });
        expect(witness.finish(20, true)).toMatchObject({ coverage: 'complete',
            servers: [{ serverName: 'docs', toolCallCount: 0, schemaBytes: null }] });
    });
    it('witnesses connected deferred servers without claiming that their definitions occupied context', () => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['Read', 'ToolSearch'],
            mcp_servers: [{ name: 'docs', status: 'connected' }] });
        witness.observe({ type: 'assistant', message: { content: [
            { type: 'tool_use', id: 'loaded-call', name: 'mcp__docs__find', input: {} },
        ] } });
        expect(witness.finish(20, true)).toMatchObject({ coverage: 'complete',
            servers: [{ serverName: 'docs', toolCallCount: 1, schemaBytes: null }] });
    });
    it.each(['pending', 'failed', 'needs-auth'])('does not promote an unavailable native server (%s) from its tool names', status => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find'],
            mcp_servers: [{ name: 'docs', status }] });
        expect(witness.finish(20, true).coverage).toBe('partial');
    });
    it.each([null, {}, [{ name: 'docs' }], [{ name: 'docs', status: 'connected' }, { name: 'docs', status: 'failed' }]])(
        'keeps malformed or duplicate native server evidence partial (%j)', mcpServers => {
            const witness = createClaudeMcpUsageWitness(['docs'], 10);
            witness.observe({ type: 'system', subtype: 'init', tools: ['ToolSearch', 'mcp__docs__find'], mcp_servers: mcpServers });
            expect(witness.finish(20, true).coverage).toBe('partial');
        });
    it('does not infer selected tool exposure from connection alone without tool search', () => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [{ name: 'docs', status: 'connected' }] });
        expect(witness.finish(20, true).coverage).toBe('partial');
    });
    it('keeps overlapping selected/native server prefixes ambiguous rather than assigning a native tool to the selected server', () => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__child__find'],
            mcp_servers: [{ name: 'docs', status: 'connected' }, { name: 'docs__child', status: 'connected' }] });
        expect(witness.finish(20, true).coverage).toBe('partial');
    });
    it('does not prove zero hidden calls from a task that completed before the foreground result', () => {
        const witness = createClaudeMcpUsageWitness(['docs'], 10);
        witness.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find'] });
        witness.observe({ type: 'system', subtype: 'task_started', task_id: 'native-child' });
        witness.observe({ type: 'system', subtype: 'task_notification', task_id: 'native-child', status: 'completed' });
        expect(witness.finish(20, true)).toMatchObject({ coverage: 'partial',
            servers: [{ serverName: 'docs', toolCallCount: 0, schemaBytes: null }] });
    });
    it('requires witnessed inventory, settled invocation and unambiguous tool mapping for complete coverage', () => {
        const missing = createClaudeMcpUsageWitness(['docs'], 10);
        expect(missing.finish(20, true).coverage).toBe('partial');
        const unsettled = createClaudeMcpUsageWitness(['docs'], 10);
        unsettled.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find'] });
        expect(unsettled.finish(20, false).coverage).toBe('partial');
        const ambiguous = createClaudeMcpUsageWitness(['docs', 'docs__child'], 10);
        ambiguous.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find', 'mcp__docs__child__find'] });
        expect(ambiguous.finish(20, true).coverage).toBe('partial');
    });
    it('withholds complete coverage when native calls escape or change the witnessed tool inventory', () => {
        const escaped = createClaudeMcpUsageWitness(['docs', 'search'], 10);
        escaped.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find', 'mcp__search__query'] });
        escaped.observe({ type: 'assistant', message: { content: [
            { type: 'tool_use', id: 'call', name: 'mcp__docs__unlisted', input: {} },
        ] } });
        expect(escaped.finish(20, true).coverage).toBe('partial');
        const changed = createClaudeMcpUsageWitness(['docs'], 10);
        changed.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__find'] });
        changed.observe({ type: 'system', subtype: 'init', tools: ['mcp__docs__other'] });
        expect(changed.finish(20, true).coverage).toBe('partial');
    });
});
