import { describe, expect, it } from 'vitest';
import { PluginAgentToolsCapabilityV2Schema } from './v2.js';
describe('MCP tool-control declaration', () => {
  it('admits declared facts and rejects unknown fields and invented authority', () => {
    expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp', mcpToolControl: { off: 'blocked', approval: 'host' }, mcpToolLoading: 'on_demand' })).toMatchObject({ mcpToolControl: { off: 'blocked', approval: 'host' } });
    expect(PluginAgentToolsCapabilityV2Schema.parse({ delivery: 'native_mcp' })).toEqual({ delivery: 'native_mcp' });
    for (const mcpToolControl of [{ off: 'hidden', approval: 'guessed' }, { off: 'hidden', approval: 'native', fallback: true }]) expect(PluginAgentToolsCapabilityV2Schema.safeParse({ delivery: 'native_mcp', mcpToolControl }).success).toBe(false);
  });
});
