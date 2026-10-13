import { describe, expect, it } from 'vitest';
import { parseMcpToolWireNameV1 } from './mcpToolIdentityV1.js';

describe('MCP wire identity', () => {
  const keys = new Set(['linear', 'linear__team', 'docs-server', 'happier']);
  it('matches the longest known record key and preserves the complete tool name', () => {
    expect(parseMcpToolWireNameV1('mcp__linear__team__create__issue', keys)).toEqual({ server: 'linear__team', tool: 'create__issue' });
    expect(parseMcpToolWireNameV1('mcp__docs-server__read_page', keys)).toEqual({ server: 'docs-server', tool: 'read_page' });
  });
  it('rejects unknown keys, incomplete names, and the built-in Happier server', () => {
    for (const name of ['mcp__unknown__tool', 'mcp__linear__', 'mcp__linear__team__', 'mcp__linear', 'mcp__happier__actions_execute', 'linear__tool']) expect(parseMcpToolWireNameV1(name, keys)).toBeNull();
  });
  it('accepts the normalized Codex MCP permission subject', () => {
    expect(parseMcpToolWireNameV1('mcp__linear__create_issue', keys)).toEqual({ server: 'linear', tool: 'create_issue' });
  });
});
