import { describe, expect, it } from 'vitest';
import { agentReceivesUserMcpServersV1 } from './v2.js';

describe('agentReceivesUserMcpServersV1', () => {
  it.each([
    ['native_mcp', true],
    ['native_extension', true],
    ['shell_bridge', false],
    ['unsupported', false],
    [undefined, false],
  ] as const)('delivery %s receives user MCP: %s', (delivery, expected) => {
    expect(agentReceivesUserMcpServersV1(delivery)).toBe(expected);
  });

  it('fails closed for an unrecognized no-delivery value', () => {
    // @ts-expect-error Exercise malformed external declaration data.
    expect(agentReceivesUserMcpServersV1('none')).toBe(false);
  });
});
